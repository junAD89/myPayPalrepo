 require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const { param, query, body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

// Firebase initialization
const serviceAccount = require('./firebase-credentials.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});
const db = admin.firestore();

// PayPal configuration
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const API_BASE = process.env.PAYPAL_ENV === 'production' 
    ? 'https://api.paypal.com' 
    : 'https://api.sandbox.paypal.com';

// Express initialization
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// PayPal access token function
async function getPayPalAccessToken() {
    console.log('[PayPal] 🔑 Requesting access token...');
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
        console.log('[PayPal] ✅ Access token obtained');
        return response.data.access_token;
    } catch (error) {
        console.error('[PayPal] ❌ Token error:', error.message);
        throw new Error('Failed to get PayPal token');
    }
}

// PayPal Routes
app.get('/api/paypal/script-url', (req, res) => {
    console.log('[PayPal] 📜 Script URL request');
    if (!PAYPAL_CLIENT_ID) {
        console.error('[PayPal] ❌ Missing Client ID');
        return res.status(500).json({ error: 'Incomplete PayPal configuration' });
    }
    const scriptUrl = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=EUR`;
    console.log('[PayPal] ✅ URL generated:', scriptUrl);
    res.json({ scriptUrl });
});

// Health Check Route// Add this near the top of your server.js file with other constants
const SUBSCRIPTION_PRICE = 4.99;

// Modify the create-order endpoint to use the server-side price
app.post('/api/paypal/create-order', [
    body('userId').isString().notEmpty(),
    body('currency').isString().optional()
], async (req, res) => {
    console.log('[PayPal] 🛍️ Creating order...');
    const { userId, currency = 'EUR' } = req.body;
    
    try {
        const accessToken = await getPayPalAccessToken();
        const response = await axios.post(`${API_BASE}/v2/checkout/orders`, {
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: currency,
                    value: SUBSCRIPTION_PRICE.toString()
                }
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        });

        console.log('[PayPal] ✅ Order created:', response.data.id);
        res.json({ 
            orderId: response.data.id,
            price: SUBSCRIPTION_PRICE
        });
    } catch (error) {
        console.error('[PayPal] ❌ Create order error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});
// Health Check Route
app.get('/api/health-check', (req, res) => {
    console.log('[Health] 🏥 Health check request received');
    try {
        // Vérification basique du serveur
        console.log('[Health] ✅ Server is healthy');
        res.json({ 
            success: true, 
            timestamp: Date.now(),
            status: 'healthy',
            // Ajout des informations importantes pour le client
            server: {
                status: 'running',
                version: process.env.npm_package_version || '1.0.0'
            }
        });
    } catch (error) {
        console.error('[Health] ❌ Health check failed:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Server health check failed',
            timestamp: Date.now()
        });
    }
});
app.post('/api/paypal/create-order', [
    body('userId').isString().notEmpty(),
    body('price').isNumeric(),
    body('currency').isString().optional()
], async (req, res) => {
    console.log('[PayPal] 🛍️ Creating order...');
    const { userId, price, currency = 'EUR' } = req.body;
    
    try {
        const accessToken = await getPayPalAccessToken();
        const response = await axios.post(`${API_BASE}/v2/checkout/orders`, {
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: currency,
                    value: price.toString()
                }
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        });

        console.log('[PayPal] ✅ Order created:', response.data.id);
        res.json({ orderId: response.data.id });
    } catch (error) {
        console.error('[PayPal] ❌ Create order error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

app.post('/api/paypal/capture-order', [
    body('orderId').isString().notEmpty(),
    body('userId').isString().notEmpty()
], async (req, res) => {
    console.log('[PayPal] 💰 Capturing order...');
    const { orderId, userId } = req.body;
    
    try {
        const accessToken = await getPayPalAccessToken();
        const response = await axios.post(
            `${API_BASE}/v2/checkout/orders/${orderId}/capture`,
            {},
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        if (response.data.status === 'COMPLETED') {
            await db.collection('users').doc(userId).update({
                premium: true,
                premiumUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log('[PayPal] ✅ Payment completed for userId:', userId);
            res.json({ success: true });
        } else {
            throw new Error('Payment not completed');
        }
    } catch (error) {
        console.error('[PayPal] ❌ Capture error:', error);
        res.status(500).json({ error: 'Failed to capture payment' });
    }
});

// Authentication Routes
app.post('/api/auth/register', [
    body('email').isEmail(),
    body('password').isLength({ min: 6 })
], async (req, res) => {
    console.log('[Auth] 📝 Registration attempt');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[Auth] ❌ Validation errors:', errors.array());
        return res.status(400).json({ 
            success: false, 
            message: errors.array()[0].msg 
        });
    }

    const { email, password } = req.body;

    try {
        const userDoc = await db.collection('users')
            .where('email', '==', email)
            .get();

        if (!userDoc.empty) {
            console.log('[Auth] ❌ Email already in use');
            return res.status(400).json({ 
                success: false, 
                message: 'Email already in use' 
            });
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const userId = `user_${Date.now()}`;

        await db.collection('users').doc(userId).set({
            email,
            password: hashedPassword,
            premium: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log('[Auth] ✅ Registration successful');
        res.json({ 
            success: true, 
            message: 'Registration successful' 
        });
    } catch (error) {
        console.error('[Auth] ❌ Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Registration error' 
        });
    }
});
 app.post('/api/auth/login', [
    body('email').isEmail(),
    body('password').notEmpty()
], async (req, res) => {
    console.log('[Auth] 🔐 Login attempt');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[Auth] ❌ Validation errors:', errors.array());
        return res.status(400).json({ 
            success: false, 
            message: errors.array()[0].msg 
        });
    }

    const { email, password } = req.body;

    try {
        const userDocs = await db.collection('users')
            .where('email', '==', email)
            .get();

        if (userDocs.empty) {
            console.log('[Auth] ❌ User not found');
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid email or password' 
            });
        }

        const userDoc = userDocs.docs[0];
        const userData = userDoc.data();

        const validPassword = await bcrypt.compare(password, userData.password);
        if (!validPassword) {
            console.log('[Auth] ❌ Invalid password');
            // Ajouter plus de logs pour déboguer
            console.log('[Auth] 🔍 Sending failure response');
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid email or password' 
            });
        }

        console.log('[Auth] ✅ Login successful');
        res.status(200).json({ 
            success: true, 
            userId: userDoc.id,
            message: 'Login successful' 
        });
    } catch (error) {
        console.error('[Auth] ❌ Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Login error' 
        });
    }
});
// Ajouter cette nouvelle route avec les routes existantes
app.post('/api/user/subscription/update', [
    body('userId').isString().notEmpty(),
    body('premium').isBoolean()
], async (req, res) => {
    console.log('[Subscription] 🔄 Updating subscription status');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[Subscription] ❌ Validation errors:', errors.array());
        return res.status(400).json({ errors: errors.array() });
    }

    const { userId, premium } = req.body;

    try {
        const userRef = db.collection('users').doc(userId);
        await userRef.update({
            premium: premium,
            premiumUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log('[Subscription] ✅ Status updated for user:', userId);
        res.json({ success: true });
    } catch (error) {
        console.error('[Subscription] ❌ Update error:', error);
        res.status(500).json({ error: 'Failed to update subscription status' });
    }
});

// Subscription check route
app.get('/api/user/subscription', [
    query('userId').isString().notEmpty()
], async (req, res) => {
    console.log('[Subscription] 🔍 Checking subscription');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('[Subscription] ❌ Validation errors:', errors.array());
        return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.query;
    console.log('[Subscription] 👤 User:', userId);

    try {
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        if (!doc.exists) {
            console.error('[Subscription] ❌ User not found:', userId);
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = doc.data();
        console.log('[Subscription] ✅ Premium status:', userData.premium);
        res.json({ 
            premium: userData.premium || false,
            userId: userId
        });
    } catch (error) {
        console.error('[Subscription] ❌ Error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('[Server] ❌ Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`[Server] 🚀 Server started on port ${PORT}`);
});