const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const https = require('https');

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
    const { email, amount, callback_url, metadata } = req.body;

    if (!email || !amount) {
      return res.status(400).json({
        status: false,
        message: 'Email and amount are required'
      });
    }

    const data = {
      email,
      amount: Math.round(amount * 100),
      callback_url,
      metadata: JSON.stringify(metadata),
      currency: 'KES',
      channels: ['card']
    };

    const response = await paystackAPI('POST', '/transaction/initialize', data);
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
app.get('/payment/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const response = await paystackAPI('GET', `/transaction/verify/${reference}`);
    res.json(response);
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      status: false,
      message: 'Payment verification failed'
    });
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
app.listen(port, () => {
  console.log(`Payment server running on port ${port}`);
}); 