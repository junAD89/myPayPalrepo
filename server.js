 require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

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

  const db = admin.firestore(); // Pour utiliser Firestore
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
app.use(cors({ origin: '*' }));// Autoriser votre frontend
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

// Route pour vérifier l'état d'abonnement
app.get('/api/user/subscription', async (req, res) => {
  const userId = req.query.userId;
  console.log(`Requête reçue pour vérifier l'abonnement de l'utilisateur ${userId}.`);
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