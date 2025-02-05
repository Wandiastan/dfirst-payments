const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const https = require('https');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Paystack API helper
const paystackAPI = async (method, path, data = null) => {
  const options = {
    hostname: 'api.paystack.co',
    port: 443,
    path,
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        resolve(JSON.parse(data));
      });
    });

    req.on('error', error => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
};

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
    error: err.message
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'success', message: 'Payment server is running' });
});

// Payment initialization endpoint
app.post('/payment/initialize', async (req, res) => {
  try {
    const { email, amount, metadata } = req.body;

    if (!email || !amount) {
      return res.status(400).json({
        status: false,
        message: 'Email and amount are required'
      });
    }

    // Get server URL for callback
    const serverUrl = process.env.NODE_ENV === 'production' 
      ? 'https://dfirst-payments.onrender.com'
      : `http://localhost:${port}`;

    // Prepare data for Paystack API
    const paystackData = {
      email,
      amount: Math.round(amount * 100),
      callback_url: `${serverUrl}/payment/verify`,
      metadata: {
        custom_fields: [
          {
            display_name: "Bot Tier",
            variable_name: "bot_tier",
            value: metadata.tier
          },
          {
            display_name: "Subscription Type",
            variable_name: "subscription_type",
            value: metadata.subscriptionType
          },
          {
            display_name: "User ID",
            variable_name: "user_id",
            value: metadata.userId
          }
        ],
        ...metadata
      },
      currency: 'KES',
      channels: ['card']
    };

    console.log('Initializing payment with data:', {
      ...paystackData,
      callback_url: paystackData.callback_url
    });

    const response = await paystackAPI('POST', '/transaction/initialize', paystackData);
    res.json(response);
  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({
      status: false,
      message: error.message || 'Failed to initialize payment'
    });
  }
});

// Payment verification endpoint
app.get('/payment/verify', async (req, res) => {
  try {
    const reference = req.query.reference;
    
    if (!reference) {
      throw new Error('No reference provided');
    }

    console.log('Verifying payment reference:', reference);
    const response = await paystackAPI('GET', `/transaction/verify/${reference}`);
    
    // Check if payment was successful
    const success = response?.data?.status === 'success';
    const metadata = response?.data?.metadata;
    
    // Always redirect to app with appropriate status
    const redirectUrl = `dfirsttrader://payment/verify?reference=${reference}&status=${success ? 'success' : 'failed'}&screen=trading`;
    console.log('Redirecting to app:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Payment verification error:', error);
    const redirectUrl = `dfirsttrader://payment/verify?reference=${req.query.reference}&status=failed&error=${encodeURIComponent(error.message)}&screen=trading`;
    res.redirect(redirectUrl);
  }
});

// Webhook endpoint for Paystack
app.post('/webhook', async (req, res) => {
  try {
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash === req.headers['x-paystack-signature']) {
      const event = req.body;
      
      switch(event.event) {
        case 'charge.success':
          console.log('Payment successful:', event.data);
          // Here you could trigger any additional success handling
          break;
        
        case 'transfer.success':
          console.log('Transfer successful:', event.data);
          break;
        
        default:
          console.log('Unhandled event:', event);
      }

      res.sendStatus(200);
    } else {
      res.sendStatus(400);
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Start server
app.listen(port, async () => {
  console.log(`Payment server running on port ${port}`);
  
  // Log server IP and Render.com IPs for Paystack whitelisting
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    console.log('\nPaystack IP Whitelist Configuration:');
    console.log('-----------------------------------');
    console.log('1. Add your current server IP:', data.ip);
    console.log('\n2. Add these Render.com IPs:');
    console.log('   - 35.196.132.4');
    console.log('   - 35.196.132.8');
    console.log('   - 35.196.132.12');
    console.log('   - 35.196.132.16');
    console.log('-----------------------------------\n');
  } catch (error) {
    console.error('Failed to get server IP:', error);
  }
}); 