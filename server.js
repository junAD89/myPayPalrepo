require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const { body, validationResult } = require('express-validator');


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
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;
const API_BASE = process.env.PAYPAL_ENV === 'production' 
  ? 'https://api.paypal.com' 
  : 'https://api.sandbox.paypal.com';

// Initialisation de l'application Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: '*' })); // Autoriser toutes les origines (à restreindre en production)
app.use(express.json());

// Fonction pour obtenir un token d'accès PayPal
async function getPayPalAccessToken() {
  try {
    const response = await axios.post(`${API_BASE}/v1/oauth2/token`, 'grant_type=client_credentials', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`
      }
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Erreur lors de la récupération du token PayPal:', error.message);
    throw new Error('Impossible de récupérer le token PayPal');
  }
}

// Route pour obtenir l'URL du script PayPal
app.get('/api/paypal/script-url', (req, res) => {
  if (!PAYPAL_CLIENT_ID) {
    return res.status(500).json({ error: 'Configuration PayPal manquante' });
  }
  const scriptUrl = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=EUR`;
  res.json({ scriptUrl });
});

// Route pour vérifier l'état d'abonnement d'un utilisateur
app.get('/api/user/subscription', [
  body('userId').isString().notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { userId } = req.query;
  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    res.json({ premium: doc.data().premium || false });
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'abonnement:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route pour créer ou mettre à jour un utilisateur
app.post('/api/user/create', [
  body('userId').isString().notEmpty(),
  body('email').isEmail(),
  body('premium').isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { userId, email, premium } = req.body;
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
    }

    await userRef.set(userData, { merge: true });
    res.json({ success: true, message: 'Utilisateur créé/mis à jour avec succès' });
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement de l\'utilisateur:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route pour créer un paiement PayPal
app.post('/api/paypal/create-payment', [
  body('userId').isString().notEmpty(),
  body('amount').isNumeric(),
  body('currency').isString().optional(),
  body('description').isString().optional()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { userId, amount, currency = 'EUR', description = 'Abonnement Premium' } = req.body;
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
      }],
      application_context: {
        return_url: `${process.env.CLIENT_URL}/payment-success`,
        cancel_url: `${process.env.CLIENT_URL}/payment-cancel`
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });

    res.json({ id: response.data.id, links: response.data.links });
  } catch (error) {
    console.error('Erreur lors de la création du paiement PayPal:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route pour capturer un paiement PayPal
app.post('/api/paypal/capture-payment', [
  body('orderId').isString().notEmpty(),
  body('userId').isString().notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { orderId, userId } = req.body;
  try {
    const accessToken = await getPayPalAccessToken();
    const response = await axios.post(`${API_BASE}/v2/checkout/orders/${orderId}/capture`, {}, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (response.data.status === 'COMPLETED') {
      const userRef = db.collection('users').doc(userId);
      await userRef.set({ premium: true }, { merge: true });
      res.json({ success: true, message: 'Paiement capturé et abonnement activé' });
    } else {
      res.json({ success: false, message: 'Statut de paiement inattendu' });
    }
  } catch (error) {
    console.error('Erreur lors de la capture du paiement PayPal:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`Serveur en écoute sur le port ${PORT}`);
});