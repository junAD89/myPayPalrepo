 require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// Déclarer db comme variable globale
let db;

// Log : Début de l'initialisation de Firebase
console.log('Début de l\'initialisation de Firebase...');

// Charger la clé de service depuis le fichier JSON
try {
  const serviceAccount = require('./firebase-credentials.json');
  console.log('Clé de service Firebase chargée avec succès.');

  // Initialiser Firebase Admin SDK
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
  });
  console.log('Firebase Admin SDK initialisé avec succès.');

  // Assigner à la variable globale
  db = admin.firestore(); 
  console.log('Firestore initialisé.');
} catch (error) {
  console.error('Erreur lors de l\'initialisation de Firebase :', error.message);
  process.exit(1); // Quitter le processus en cas d'erreur critique
}

// Configuration de PayPal
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;
const API_BASE = 'https://api.sandbox.paypal.com'; // Utilisez 'https://api.paypal.com' en production

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: '*' })); // Autoriser toutes les origines (à restreindre en production)
app.use(express.json());

// Log : Démarrage du serveur
console.log('Configuration du serveur en cours...');

// Fonction pour obtenir un token d'accès PayPal
async function getPayPalAccessToken() {
  console.log('Tentative de récupération du token d\'accès PayPal...');
  try {
    const response = await axios({
      method: 'post',
      url: `${API_BASE}/v1/oauth2/token`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`
      },
      data: 'grant_type=client_credentials'
    });
    console.log('Token d\'accès PayPal récupéré avec succès.');
    return response.data.access_token;
  } catch (error) {
    console.error('Erreur lors de la récupération du token PayPal:', error.message);
    throw error;
  }
}

// Route pour obtenir l'URL du script PayPal
app.get('/api/paypal/script-url', (req, res) => {
  if (!PAYPAL_CLIENT_ID) {
    console.error('Erreur : PAYPAL_CLIENT_ID non défini dans les variables d\'environnement');
    return res.status(500).json({ error: 'Configuration PayPal manquante' });
  }
  
  // Générer l'URL du script avec le client ID stocké en sécurité sur le serveur
  const scriptUrl = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=EUR`;
  
  console.log('URL du script PayPal générée');
  res.json({ scriptUrl });
});

// Fonction pour vérifier l'état d'abonnement d'un utilisateur
async function checkUserSubscription(userId) {
  console.log(`Vérification de l'abonnement pour l'utilisateur ${userId}...`);
  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
      console.log(`Utilisateur ${userId} non trouvé.`);
      return false;
    }
    console.log(`Utilisateur ${userId} trouvé. Statut premium :`, doc.data().premium || false);
    return doc.data().premium || false;
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'abonnement:', error.message);
    throw error;
  }
}

// Fonction pour mettre à jour l'état d'abonnement d'un utilisateur
async function updateUserSubscription(userId, premiumStatus) {
  console.log(`Mise à jour du statut premium pour l'utilisateur ${userId} : ${premiumStatus}`);
  try {
    const userRef = db.collection('users').doc(userId);
    await userRef.set({ premium: premiumStatus }, { merge: true });
    console.log(`Statut d'abonnement mis à jour pour l'utilisateur ${userId}.`);
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'abonnement:', error.message);
    throw error;
  }
}
// Ajouter cette route à votre fichier serveur existant

// Route pour vérifier si un email existe déjà
app.get('/api/user/check-email', async (req, res) => {
  const email = req.query.email;
  
  if (!email) {
    return res.status(400).json({ error: 'Email manquant' });
  }

  console.log(`Vérification de l'existence de l'email ${email}...`);
  
  try {
    // Chercher dans la collection users les documents où l'email correspond
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('email', '==', email).get();
    
    if (snapshot.empty) {
      console.log(`Aucun utilisateur trouvé avec l'email ${email}`);
      return res.json({ exists: false, userId: null });
    }
    
    // S'il existe, renvoyer l'ID du premier document trouvé
    const userData = snapshot.docs[0];
    console.log(`Utilisateur trouvé avec l'email ${email}: ${userData.id}`);
    
    return res.json({ 
      exists: true, 
      userId: userData.id 
    });
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'email:', error.message);
    res.status(500).json({ error: 'Erreur lors de la vérification de l\'email' });
  }
}); 
// Route pour vérifier l'état d'abonnement
app.get('/api/user/subscription', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'ID utilisateur manquant' });
  }

  console.log(`Requête reçue pour vérifier l'abonnement de l'utilisateur ${userId}.`);
  try {
    const isPremium = await checkUserSubscription(userId);
    res.json({ premium: isPremium });
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'abonnement:', error.message);
    res.status(500).json({ error: 'Erreur lors de la vérification de l\'abonnement' });
  }
});

// Ajouter cette route à votre fichier serveur existant

// Route pour créer/mettre à jour un utilisateur dans Firestore
// Route améliorée pour créer/mettre à jour un utilisateur dans Firestore
app.post('/api/user/create', async (req, res) => {
  const { userId, email, premium } = req.body;
  
  if (!userId || !email) {
    return res.status(400).json({ error: 'Données utilisateur manquantes' });
  }

  console.log(`Demande de création/mise à jour pour l'utilisateur ${userId} (${email})`);
  
  try {
    // Vérifier si l'utilisateur existe déjà
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      console.log(`Utilisateur ${userId} trouvé dans Firestore. Mise à jour des informations.`);
      
      // Mettre à jour uniquement le champ updatedAt et conserver les autres données
      await userRef.update({
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Si l'email est différent, mettre à jour ce champ aussi
      const userData = userDoc.data();
      if (userData.email !== email) {
        await userRef.update({
          email: email
        });
        console.log(`Email de l'utilisateur ${userId} mis à jour: ${email}`);
      }
      
      console.log(`Données de l'utilisateur ${userId} mises à jour avec succès.`);
      res.json({ success: true, message: 'Informations utilisateur mises à jour', isNew: false });
    } else {
      // Créer un nouveau document utilisateur
      console.log(`Utilisateur ${userId} non trouvé. Création d'un nouveau profil.`);
      await userRef.set({
        email: email,
        premium: premium || false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log(`Nouvel utilisateur ${userId} (${email}) enregistré avec succès.`);
      res.json({ success: true, message: 'Nouvel utilisateur enregistré', isNew: true });
    }
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement de l\'utilisateur:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'enregistrement de l\'utilisateur' });
  }
});


// Ajoutez ces nouvelles routes à votre fichier serveur existant

// Route pour créer un paiement PayPal
app.post('/api/paypal/create-payment', async (req, res) => {
  const { userId, amount, currency = 'EUR', description = 'Abonnement Premium' } = req.body;
  
  if (!userId || !amount) {
    return res.status(400).json({ error: 'Données de paiement manquantes' });
  }

  console.log(`Création d'un paiement PayPal pour l'utilisateur ${userId} de ${amount} ${currency}`);
  
  try {
    const accessToken = await getPayPalAccessToken();
    
    // Création de l'ordre PayPal
    const response = await axios({
      method: 'post',
      url: `${API_BASE}/v2/checkout/orders`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      data: {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: currency,
            value: amount.toString()
          },
          description: description,
          custom_id: userId // Pour identifier l'utilisateur dans le webhook
        }],
        application_context: {
          return_url: `${process.env.CLIENT_URL}/payment-success`,
          cancel_url: `${process.env.CLIENT_URL}/payment-cancel`
        }
      }
    });
    
    console.log('Paiement PayPal créé avec succès:', response.data.id);
    res.json({
      id: response.data.id,
      links: response.data.links
    });
  } catch (error) {
    console.error('Erreur lors de la création du paiement PayPal:', error.message);
    res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
});

// Route pour capturer un paiement PayPal
app.post('/api/paypal/capture-payment', async (req, res) => {
  const { orderId, userId } = req.body;
  
  if (!orderId || !userId) {
    return res.status(400).json({ error: 'Données manquantes' });
  }

  console.log(`Capture du paiement PayPal (${orderId}) pour l'utilisateur ${userId}`);
  
  try {
    const accessToken = await getPayPalAccessToken();
    
    // Capture de l'ordre PayPal
    const response = await axios({
      method: 'post',
      url: `${API_BASE}/v2/checkout/orders/${orderId}/capture`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    // Si la capture est réussie, mettre à jour l'abonnement de l'utilisateur
    if (response.data.status === 'COMPLETED') {
      console.log(`Paiement PayPal ${orderId} complété. Mise à jour du statut premium pour l'utilisateur ${userId}.`);
      await updateUserSubscription(userId, true);
      
      res.json({
        success: true,
        status: response.data.status,
        message: 'Paiement capturé et abonnement activé'
      });
    } else {
      console.warn(`Paiement PayPal ${orderId} avec statut inattendu:`, response.data.status);
      res.json({
        success: false,
        status: response.data.status,
        message: 'Statut de paiement inattendu'
      });
    }
  } catch (error) {
    console.error('Erreur lors de la capture du paiement PayPal:', error.message);
    res.status(500).json({ error: 'Erreur lors de la capture du paiement' });
  }
});

// Route pour vérifier le statut d'un paiement PayPal
app.get('/api/paypal/check-payment/:orderId', async (req, res) => {
  const { orderId } = req.params;
  
  if (!orderId) {
    return res.status(400).json({ error: 'ID de commande manquant' });
  }

  console.log(`Vérification du statut du paiement PayPal ${orderId}`);
  
  try {
    const accessToken = await getPayPalAccessToken();
    
    // Récupérer les détails de l'ordre PayPal
    const response = await axios({
      method: 'get',
      url: `${API_BASE}/v2/checkout/orders/${orderId}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    console.log(`Statut du paiement PayPal ${orderId}:`, response.data.status);
    res.json({
      status: response.data.status,
      details: response.data
    });
  } catch (error) {
    console.error('Erreur lors de la vérification du paiement PayPal:', error.message);
    res.status(500).json({ error: 'Erreur lors de la vérification du paiement' });
  }
});

// Route pour mettre à jour l'abonnement
 app.post('/api/user/subscription/update', async (req, res) => {
    const { userId, premiumStatus } = req.body;
    if (!userId || premiumStatus === undefined) {
        return res.status(400).json({ error: 'Données manquantes' });
    }

    try {
        await updateUserSubscription(userId, premiumStatus);
        res.json({ success: true, message: 'Statut premium mis à jour' });
    } catch (error) {
        console.error('Erreur lors de la mise à jour de l\'abonnement:', error.message);
        res.status(500).json({ error: 'Erreur lors de la mise à jour de l\'abonnement' });
    }
});
// Route pour recevoir les webhooks PayPal
app.post('/webhook', async (req, res) => {
  console.log('Webhook PayPal reçu :', req.body);
  const webhook_event = req.body;
  try {
    const verificationStatus = await verifyWebhookSignature({
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event
    });

    if (verificationStatus === 'SUCCESS') {
      console.log('Webhook vérifié avec succès. Événement :', webhook_event.event_type);

      switch (webhook_event.event_type) {
        case 'PAYMENT.SALE.COMPLETED':
          const userId = webhook_event.resource.custom_id;
          console.log(`Paiement réussi pour l'utilisateur ${userId}. Mise à jour du statut premium.`);
          await updateUserSubscription(userId, true);
          break;
        default:
          console.warn('Événement non traité:', webhook_event.event_type);
      }
      res.status(200).json({ status: 'OK' });
    } else {
      console.error('Erreur : Signature du webhook invalide.');
      res.status(400).json({ error: 'Signature du webhook invalide' });
    }
  } catch (error) {
    console.error('Erreur lors du traitement du webhook :', error.message);
    res.status(500).json({ error: 'Erreur lors du traitement du webhook' });
  }
});

// Fonction pour vérifier la signature du webhook PayPal
async function verifyWebhookSignature(data) {
  console.log('Vérification de la signature du webhook...');
  try {
    const accessToken = await getPayPalAccessToken();
    const response = await axios.post(
      `${API_BASE}/v1/notifications/verify-webhook-signature`,
      data,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    console.log('Signature du webhook vérifiée avec succès.');
    return response.data.verification_status;
  } catch (error) {
    console.error('Erreur lors de la vérification de la signature du webhook:', error.message);
    return 'ERROR';
  }
}

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`Serveur en écoute sur le port ${PORT}`);
});