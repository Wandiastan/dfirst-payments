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

    // Handle M-Pesa payment
    if (metadata?.paymentMethod === 'mpesa' && metadata?.phoneNumber) {
      console.log('Initializing M-Pesa payment:', {
        amount,
        phone: metadata.phoneNumber,
        email
      });

      try {
        // Initialize M-Pesa payment according to Paystack docs
        const mpesaData = {
          email,
          amount: amount,
          currency: "KES",
          mobile_money: {
            phone: metadata.phoneNumber,
            provider: "mpesa"
          },
          channels: ["mobile_money"],
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
          callback_url: `${serverUrl}/payment/verify`,
          return_url: metadata.returnUrl
        };

        console.log('Initializing M-Pesa payment with data:', mpesaData);

        const stkResponse = await paystackAPI('POST', '/transaction/initialize', mpesaData);

        console.log('M-Pesa STK response:', stkResponse);

        if (!stkResponse.status) {
          throw new Error(stkResponse.message || 'Failed to initialize M-Pesa payment');
        }

        return res.json(stkResponse);
      } catch (mpesaError) {
        console.error('M-Pesa initialization error:', mpesaError);
        throw new Error('Failed to initialize M-Pesa payment: ' + mpesaError.message);
      }
    }

    // Handle card payment with correct amount multiplication
    const paystackData = {
      email,
      amount: amount * 100, // Only multiply by 100 for card payments
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

    // Add verification tracking
    const verificationKey = `verification_${reference}`;
    if (global[verificationKey]) {
      console.log('Payment already verified:', reference);
      // Return cached result
      return res.json(global[verificationKey]);
    }

    console.log('Verifying payment reference:', reference);
    const response = await paystackAPI('GET', `/transaction/verify/${reference}`);
    
    // Check if payment was successful
    const success = response?.data?.status === 'success';
    const metadata = response?.data?.metadata;
    
    // Add payment reference to metadata
    if (success && metadata) {
      metadata.paymentReference = reference;
    }

    // Cache verification result
    global[verificationKey] = response;
    
    // Check if client accepts JSON (API request) or HTML (browser redirect)
    const acceptsJson = req.headers.accept?.includes('application/json');
    
    if (acceptsJson) {
      // Return JSON response for API requests
      res.json(response);
    } else {
      // Redirect to app for browser requests with all necessary data
      const redirectUrl = `dfirsttrader://payment/verify?reference=${reference}&status=${success ? 'success' : 'failed'}&screen=trading&botName=${encodeURIComponent(metadata?.botName || '')}&tier=${encodeURIComponent(metadata?.tier || '')}`;
      console.log('Redirecting to app:', redirectUrl);
      res.redirect(redirectUrl);
    }

    // Clear verification cache after 5 minutes
    setTimeout(() => {
      delete global[verificationKey];
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error('Payment verification error:', error);
    
    const acceptsJson = req.headers.accept?.includes('application/json');
    if (acceptsJson) {
      res.status(500).json({
        status: false,
        message: error.message || 'Payment verification failed'
      });
    } else {
      const redirectUrl = `dfirsttrader://payment/verify?reference=${req.query.reference}&status=failed&error=${encodeURIComponent(error.message)}&screen=trading`;
      res.redirect(redirectUrl);
    }
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

// Add M-Pesa webhook handler
app.post('/mpesa/webhook', async (req, res) => {
  try {
    const event = req.body;
    console.log('M-Pesa webhook received:', event);

    if (event.event === 'charge.success' && event.data.channel === 'mobile_money') {
      const reference = event.data.reference;
      const metadata = event.data.metadata;

      // Update payment status
      console.log('Processing successful M-Pesa payment:', {
        reference,
        metadata
      });

      // Verify the payment
      const verificationResponse = await paystackAPI('GET', `/transaction/verify/${reference}`);
      
      if (verificationResponse.data.status === 'success') {
        // Handle successful payment verification
        console.log('M-Pesa payment verified:', verificationResponse.data);
        
        // Add verification tracking
        const verificationKey = `verification_${reference}`;
        global[verificationKey] = {
          status: true,
          data: verificationResponse.data
        };

        // Clear verification cache after 5 minutes
        setTimeout(() => {
          delete global[verificationKey];
        }, 5 * 60 * 1000);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('M-Pesa webhook error:', error);
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