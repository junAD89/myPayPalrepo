require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// Initialisation de Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});
const db = admin.firestore();

// Configuration de PayPal
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;
const API_BASE = 'https://api.sandbox.paypal.com'; // Utilisez 'https://api.paypal.com' en production

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: 'https://votre-frontend.glitch.me' })); // Autoriser votre frontend
app.use(express.json());

// Fonction pour obtenir un token d'accès PayPal
async function getPayPalAccessToken() {
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
    return response.data.access_token;
  } catch (error) {
    console.error('Erreur lors de la récupération du token PayPal:', error.message);
    throw error;
  }
}

// Fonction pour vérifier l'état d'abonnement d'un utilisateur
async function checkUserSubscription(userId) {
  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
      console.log(`Utilisateur ${userId} non trouvé`);
      return false;
    }
    return doc.data().premium || false;
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'abonnement:', error.message);
    throw error;
  }
}

// Fonction pour mettre à jour l'état d'abonnement d'un utilisateur
async function updateUserSubscription(userId, premiumStatus) {
  try {
    const userRef = db.collection('users').doc(userId);
    await userRef.set({ premium: premiumStatus }, { merge: true });
    console.log(`Statut d'abonnement mis à jour pour l'utilisateur ${userId}: ${premiumStatus}`);
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'abonnement:', error.message);
    throw error;
  }
}

// Route pour vérifier l'état d'abonnement
app.get('/api/user/subscription', async (req, res) => {
  const userId = req.query.userId;
  try {
    const isPremium = await checkUserSubscription(userId);
    res.json({ premium: isPremium });
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'abonnement:', error.message);
    res.status(500).json({ error: 'Erreur lors de la vérification de l\'abonnement' });
  }
});

// Route pour recevoir les webhooks PayPal
app.post('/webhook', async (req, res) => {
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