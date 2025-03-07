require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const { param, query, body, validationResult } = require('express-validator');

const bcrypt = require('bcrypt');
const SALT_ROUNDS = 10;
// Initialisation de Firebase
const serviceAccount = require('./firebase-credentials.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});
const db = admin.firestore();

// Configuration de PayPal
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const API_BASE = process.env.PAYPAL_ENV === 'production' 
  ? 'https://api.paypal.com' 
  : 'https://api.sandbox.paypal.com';

// Initialisation de l'application Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Middleware de logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Fonction pour obtenir un token d'accès PayPal
async function getPayPalAccessToken() {
    console.log('[PayPal] 🔑 Demande de token d\'accès...');
    try {
        const response = await axios.post(`${API_BASE}/v1/oauth2/token`, 
            'grant_type=client_credentials', 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`
                }
            }
        );
        console.log('[PayPal] ✅ Token d\'accès obtenu');
        return response.data.access_token;
    } catch (error) {
        console.error('[PayPal] ❌ Erreur token:', error.message);
        throw new Error('Échec de récupération du token PayPal');
    }
}

// Route pour obtenir l'URL du script PayPal
app.get('/api/paypal/script-url', (req, res) => {
    console.log('[PayPal] 📜 Demande d\'URL de script');
    if (!PAYPAL_CLIENT_ID) {
        console.error('[PayPal] ❌ Client ID manquant');
        return res.status(500).json({ error: 'Configuration PayPal incomplète' });
    }
    const scriptUrl = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=EUR`;
    console.log('[PayPal] ✅ URL générée:', scriptUrl);
    res.json({ scriptUrl });
});

// Route d'inscription
app.post('/api/auth/register', [
    body('email').isEmail().withMessage('Email invalide'),
    body('password').isLength({ min: 6 }).withMessage('Le mot de passe doit faire au moins 6 caractères')
], async (req, res) => {
    console.log('[Auth] 📝 Tentative d\'inscription');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[Auth] ❌ Erreurs de validation:', errors.array());
        return res.status(400).json({ 
            success: false, 
            message: errors.array()[0].msg 
        });
    }

    const { email, password } = req.body;

    try {
        // Vérifier si l'email existe déjà
        const userDoc = await db.collection('users')
            .where('email', '==', email)
            .get();

        if (!userDoc.empty) {
            console.log('[Auth] ❌ Email déjà utilisé');
            return res.status(400).json({ 
                success: false, 
                message: 'Cet email est déjà utilisé' 
            });
        }

        // Hasher le mot de passe
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const userId = `user_${Date.now()}`;

        // Créer l'utilisateur
        await db.collection('users').doc(userId).set({
            email,
            password: hashedPassword,
            premium: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log('[Auth] ✅ Inscription réussie');
        res.json({ 
            success: true, 
            message: 'Inscription réussie' 
        });
    } catch (error) {
        console.error('[Auth] ❌ Erreur:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erreur lors de l\'inscription' 
        });
    }
});

// Route de connexion
app.post('/api/auth/login', [
    body('email').isEmail().withMessage('Email invalide'),
    body('password').notEmpty().withMessage('Mot de passe requis')
], async (req, res) => {
    console.log('[Auth] 🔐 Tentative de connexion');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[Auth] ❌ Erreurs de validation:', errors.array());
        return res.status(400).json({ 
            success: false, 
            message: errors.array()[0].msg 
        });
    }

    const { email, password } = req.body;

    try {
        // Rechercher l'utilisateur
        const userDocs = await db.collection('users')
            .where('email', '==', email)
            .get();

        if (userDocs.empty) {
            console.log('[Auth] ❌ Utilisateur non trouvé');
            return res.status(400).json({ 
                success: false, 
                message: 'Email ou mot de passe incorrect' 
            });
        }

        const userDoc = userDocs.docs[0];
        const userData = userDoc.data();

        // Vérifier le mot de passe
        const validPassword = await bcrypt.compare(password, userData.password);
        if (!validPassword) {
            console.log('[Auth] ❌ Mot de passe incorrect');
            return res.status(400).json({ 
                success: false, 
                message: 'Email ou mot de passe incorrect' 
            });
        }

        console.log('[Auth] ✅ Connexion réussie');
        res.json({ 
            success: true, 
            userId: userDoc.id,
            message: 'Connexion réussie' 
        });
    } catch (error) {
        console.error('[Auth] ❌ Erreur:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erreur lors de la connexion' 
        });
    }
});


// Route pour vérifier l'abonnement
app.get('/api/user/subscription', [
    query('userId').isString().notEmpty().withMessage('userId requis')
], async (req, res) => {
    console.log('[Subscription] 🔍 Vérification d\'abonnement');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[Subscription] ❌ Erreurs de validation:', errors.array());
        return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.query;
    console.log('[Subscription] 👤 Utilisateur:', userId);

    try {
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        if (!doc.exists) {
            console.error('[Subscription] ❌ Utilisateur non trouvé:', userId);
            return res.status(404).json({ error: 'Utilisateur non trouvé' });
        }

        const userData = doc.data();
        console.log('[Subscription] ✅ Statut premium:', userData.premium);
        res.json({ 
            premium: userData.premium || false,
            userId: userId // Ajout explicite de l'userId dans la réponse
        });
    } catch (error) {
        console.error('[Subscription] ❌ Erreur:', error.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
app.post('/api/paypal/create-payment', [
    body('userId').isString().notEmpty(),
    body('amount').isNumeric(),
    body('currency').isString().optional(),
    body('description').isString().optional()
], async (req, res) => {
    console.log('[PayPal] 🔄 Création paiement...');
    const { userId, amount, currency = 'EUR', description } = req.body;
    
    try {
        const accessToken = await getPayPalAccessToken();
        const response = await axios.post(`${API_BASE}/v2/checkout/orders`, {
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: currency,
                    value: amount.toString()
                },
                description,
                custom_id: userId
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        });

        console.log('[PayPal] ✅ Paiement créé:', response.data.id);
        res.json({
            success: true,
            id: response.data.id,
            links: response.data.links
        });
    } catch (error) {
        console.error('[PayPal] ❌ Erreur création:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erreur lors de la création du paiement'
        });
    }
});
// Route pour créer/mettre à jour un utilisateur
app.post('/api/user/create', [
    body('userId').isString().notEmpty(),
    body('email').isEmail(),
    body('premium').isBoolean()
], async (req, res) => {
    console.log('[User] 📝 Création/mise à jour utilisateur');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[User] ❌ Erreurs de validation:', errors.array());
        return res.status(400).json({ errors: errors.array() });
    }

    const { userId, email, premium } = req.body;
    console.log('[User] 📊 Données:', { userId, email, premium });

    try {
        const userRef = db.collection('users').doc(userId);
        const userData = {
            email,
            premium,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const doc = await userRef.get();
        if (!doc.exists) {
            userData.createdAt = admin.firestore.FieldValue.serverTimestamp();
            console.log('[User] ✨ Nouvel utilisateur');
        } else {
            console.log('[User] 🔄 Mise à jour utilisateur');
        }

        await userRef.set(userData, { merge: true });
        console.log('[User] ✅ Opération réussie');
        
        res.json({ 
            success: true, 
            message: 'Utilisateur créé/mis à jour avec succès',
            userId: userId // Ajout explicite de l'userId dans la réponse
        });
    } catch (error) {
        console.error('[User] ❌ Erreur:', error.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Route pour créer un paiement PayPal
app.post('/api/paypal/create-payment', [
    body('userId').isString().notEmpty(),
    body('amount').isNumeric(),
    body('currency').optional().isString(),
    body('description').optional().isString()
], async (req, res) => {
    // ... reste du code PayPal inchangé ...
});

// Route pour capturer un paiement PayPal
app.post('/api/paypal/capture-payment', [
    body('orderId').isString().notEmpty(),
    body('userId').isString().notEmpty()
], async (req, res) => {
    // ... reste du code PayPal inchangé ...
});

// Middleware de gestion d'erreur global
app.use((err, req, res, next) => {
    console.error('[Server] ❌ Erreur non gérée:', err);
    res.status(500).json({ error: 'Erreur serveur interne' });
});

// Démarrage du serveur
app.listen(PORT, () => {
    console.log(`[Server] 🚀 Serveur démarré sur le port ${PORT}`);
});