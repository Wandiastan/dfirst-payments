const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const Paystack = require('paystack-node');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Paystack
const paystack = new Paystack(process.env.PAYSTACK_SECRET_KEY);

app.use(cors());
app.use(express.json());

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
        status: 'error',
        message: 'Email and amount are required'
      });
    }

    // Convert metadata to string as required by Paystack
    const stringifiedMetadata = JSON.stringify(metadata);

    const response = await paystack.initializeTransaction({
      email,
      amount,
      callback_url,
      metadata: stringifiedMetadata, // Send stringified metadata
      channels: ['card'], // Specify allowed payment channels
      currency: 'KES' // Specify currency
    });

    if (!response.status) {
      return res.status(400).json({
        status: 'error',
        message: response.message || 'Payment initialization failed'
      });
    }

    res.json({
      status: true,
      message: 'Payment initialized',
      data: response.data
    });
  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to initialize payment'
    });
  }
});

// Payment verification endpoint
app.get('/payment/verify/:reference', async (req, res) => {
  try {
    const reference = req.params.reference;
    const response = await paystack.verifyTransaction(reference);

    if (response.data.status === 'success') {
      res.json({
        status: 'success',
        message: 'Payment verified successfully',
        data: response.data
      });
    } else {
      res.status(400).json({
        status: 'error',
        message: 'Payment verification failed',
        data: response.data
      });
    }
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Webhook endpoint for Paystack
app.post('/webhook', async (req, res) => {
  try {
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
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