  require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');


const app = express();
const PORT = process.env.PORT || 3001;

// Récupérer les identifiants PayPal à partir des variables d'environnement
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_BASE = 'https://api.sandbox.paypal.com'; // Utilisez 'https://api.paypal.com' pour production

// Vérifier si les identifiants sont présents
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error('Erreur : Les variables d\'environnement PAYPAL_CLIENT_ID et PAYPAL_CLIENT_SECRET doivent être définies.');
  process.exit(1);
}


// Activation du CORS pour permettre les requêtes depuis le frontend
app.use(cors({
  origin: 'http://localhost:3000', // Autorise uniquement votre frontend local
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true // Activation si vous utilisez des cookies ou des en-têtes d'autorisation
}));


// Route simple pour tester les identifiants PayPal
app.get('/test-paypal-auth', async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    res.json({ success: true, message: 'Authentification réussie', token_start: accessToken.substring(0, 10) + '...' });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Échec de l\'authentification', 
      error: error.message,
      details: error.response?.data 
    });
  }
});


// Middleware pour parser le JSON
app.use(express.json());

// Middleware de logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  console.log('Origin:', req.headers.origin);
  next();
});

// Fonction pour obtenir un token d'accès PayPal
async function getPayPalAccessToken() {
  try {
    console.log('Début de la récupération du token d\'accès PayPal');
    const response = await axios({
      method: 'post',
      url: `${API_BASE}/v1/oauth2/token`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`
      },
      data: 'grant_type=client_credentials'
    });
    console.log('Token d\'accès PayPal récupéré avec succès');
    return response.data.access_token;
  } catch (error) {
    console.error('Erreur lors de l\'obtention du token PayPal:', error.message);
    throw error;
  }
}

// Fonction auxiliaire pour créer un produit (nécessaire pour les plans)
async function createProduct(accessToken, name, description) {
  try {
    console.log('Début de la création du produit');
    const response = await axios({
      method: 'post',
      url: `${API_BASE}/v1/catalogs/products`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      data: {
        name,
        description,
        type: 'SERVICE',
        category: 'SOFTWARE'
      }
    });
    console.log('Produit créé avec succès');
    return response.data.id;
  } catch (error) {
    console.error('Erreur lors de la création du produit:', error.response?.data || error.message);
    throw error;
  }
}

// Route pour créer un plan d'abonnement
app.post('/api/plans', async (req, res) => {
  try {
    console.log('Début de la création du plan d\'abonnement');
    const { name, description, amount, currency, interval, interval_count } = req.body;
    console.log('Données de la requête:', req.body);

    const accessToken = await getPayPalAccessToken();

    // Créer le plan
    const response = await axios({
      method: 'post',
      url: `${API_BASE}/v1/billing/plans`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      data: {
        product_id: await createProduct(accessToken, name, description),
        name,
        description,
        billing_cycles: [
          {
            frequency: {
              interval_unit: interval,
              interval_count: interval_count || 1
            },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0, // 0 means unlimited
            pricing_scheme: {
              fixed_price: {
                value: amount,
                currency_code: currency
              }
            }
          }
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee: {
            value: "0",
            currency_code: currency
          },
          setup_fee_failure_action: "CONTINUE",
          payment_failure_threshold: 3
        }
      }
    });

    console.log('Plan créé avec succès');
    res.json(response.data);
  } catch (error) {
    console.error('Erreur lors de la création du plan:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erreur lors de la création du plan', details: error.response?.data || error.message });
  }
});

// Route pour créer un abonnement
app.post('/api/subscriptions', async (req, res) => {
  try {
    console.log('Début de la création de l\'abonnement');
    const { plan_id, user_email, return_url, cancel_url } = req.body;
    console.log('Données de la requête:', req.body);

    const accessToken = await getPayPalAccessToken();

    const response = await axios({
      method: 'post',
      url: `${API_BASE}/v1/billing/subscriptions`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      data: {
        plan_id,
        subscriber: {
          email_address: user_email
        },
        application_context: {
          brand_name: "Votre Entreprise",
          locale: "fr-FR",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          return_url: return_url || `${BASE_URL}/success`,
          cancel_url: cancel_url || `${BASE_URL}/cancel`
        }
      }
    });

    console.log('Abonnement créé avec succès');
    res.json(response.data);
  } catch (error) {
    console.error('Erreur lors de la création de l\'abonnement:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erreur lors de la création de l\'abonnement', details: error.response?.data || error.message });
  }
});

// Route pour annuler un abonnement
app.post('/api/subscriptions/:subscription_id/cancel', async (req, res) => {
  try {
    console.log(`Début de l'annulation de l'abonnement avec l'ID: ${req.params.subscription_id}`);
    const { subscription_id } = req.params;
    const { reason } = req.body;
    console.log('Données de la requête:', req.body);

    const accessToken = await getPayPalAccessToken();

    await axios({
      method: 'post',
      url: `${API_BASE}/v1/billing/subscriptions/${subscription_id}/cancel`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      data: {
        reason: reason || "Annulation demandée par l'utilisateur"
      }
    });

    console.log('Abonnement annulé avec succès');
    res.json({ status: 'SUCCESS', message: 'Abonnement annulé avec succès' });
  } catch (error) {
    console.error('Erreur lors de l\'annulation de l\'abonnement:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erreur lors de l\'annulation de l\'abonnement', details: error.response?.data || error.message });
  }
});

// Route pour obtenir les détails d'un abonnement
app.get('/api/subscriptions/:subscription_id', async (req, res) => {
  try {
    console.log(`Début de la récupération des détails de l'abonnement avec l'ID: ${req.params.subscription_id}`);
    const { subscription_id } = req.params;

    const accessToken = await getPayPalAccessToken();

    const response = await axios({
      method: 'get',
      url: `${API_BASE}/v1/billing/subscriptions/${subscription_id}`,
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    console.log('Détails de l\'abonnement récupérés avec succès');
    res.json(response.data);
  } catch (error) {
    console.error('Erreur lors de la récupération des détails de l\'abonnement:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des détails de l\'abonnement', details: error.response?.data || error.message });
  }
});

// Route pour récupérer les plans disponibles
app.get('/api/plans', async (req, res) => {
  try {
    console.log('Début de la récupération des plans disponibles');

    const accessToken = await getPayPalAccessToken();

    const response = await axios({
      method: 'get',
      url: `${API_BASE}/v1/billing/plans`,
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    console.log('Plans récupérés avec succès');
    res.json(response.data.plans);
  } catch (error) {
    console.error('Erreur lors de la récupération des plans:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des plans', details: error.response?.data || error.message });
  }
});

// Route pour recevoir les webhooks PayPal
app.post('/webhook', async (req, res) => {
  try {
    console.log('Début du traitement du webhook PayPal');
    const auth_algo = req.headers['paypal-auth-algo'];
    const cert_url = req.headers['paypal-cert-url'];
    const transmission_id = req.headers['paypal-transmission-id'];
    const transmission_sig = req.headers['paypal-transmission-sig'];
    const transmission_time = req.headers['paypal-transmission-time'];
    const webhook_event = req.body;
    console.log('Données du webhook:', req.body);

    if (!PAYPAL_WEBHOOK_ID) {
      console.error('Erreur : La variable d\'environnement PAYPAL_WEBHOOK_ID doit être définie.');
      res.status(500).json({ error: 'Erreur de configuration du webhook' });
      return;
    }

    const data = {
      auth_algo,
      cert_url,
      transmission_id,
      transmission_sig,
      transmission_time,
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event
    };

    const verificationStatus = await verifyWebhookSignature(data);

    if (verificationStatus === 'SUCCESS') {
      console.log('Webhook vérifié avec succès. Événement :', webhook_event.event_type);

      // Traiter les différents types d'événements d'abonnement
      switch (webhook_event.event_type) {
        case 'BILLING.SUBSCRIPTION.CREATED':
          // Un nouvel abonnement a été créé
          console.log('Nouvel abonnement créé:', webhook_event.resource.id);
          break;

        case 'BILLING.SUBSCRIPTION.CANCELLED':
          // Un abonnement a été annulé
          console.log('Abonnement annulé:', webhook_event.resource.id);
          break;

        case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
          // Un paiement d'abonnement a échoué
          console.log('Paiement échoué pour l\'abonnement:', webhook_event.resource.id);
          break;

        case 'PAYMENT.SALE.COMPLETED':
          // Un paiement a été réalisé avec succès
          console.log('Paiement réussi pour la transaction:', webhook_event.resource.id);
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
    console.error('Erreur lors du traitement du webhook :', error);
    res.status(500).json({ error: 'Erreur lors du traitement du webhook' });
  }
});

// Fonction pour vérifier la signature du webhook
async function verifyWebhookSignature(data) {
  try {
    console.log('Début de la vérification de la signature du webhook');
    console.log('Données de vérification:', data);

    const accessToken = await getPayPalAccessToken();

    const response = await axios.post(
      `${API_BASE}/v1/notifications/verify-webhook-signature`,
      {
        auth_algo: data.auth_algo,
        cert_url: data.cert_url,
        transmission_id: data.transmission_id,
        transmission_sig: data.transmission_sig,
        transmission_time: data.transmission_time,
        webhook_id: data.webhook_id,
        webhook_event: data.webhook_event
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    console.log('Signature du webhook vérifiée avec succès');
    return response.data.verification_status;
  } catch (error) {
    console.error('Erreur lors de la vérification de la signature du webhook:', error);
    return 'ERROR';
  }
}

// Route simple pour tester que le serveur fonctionne
app.get('/', (req, res) => {
  res.send('Serveur PayPal fonctionne correctement');
});

// Démarrage du serveur
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur Express démarré sur le port ${PORT}`);
});