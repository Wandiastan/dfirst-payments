const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Paystack = require('paystack-node');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Paystack
const paystack = new Paystack(process.env.PAYSTACK_SECRET_KEY);

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Payment server is running' });
});

// Payment verification endpoint
app.get('/payment/verify/:reference', async (req, res) => {
  try {
    const reference = req.params.reference;
    const response = await paystack.verifyTransaction(reference);

    if (response.data.status === 'success') {
      // Payment successful
      res.json({
        status: 'success',
        message: 'Payment verified successfully',
        data: response.data
      });
    } else {
      // Payment failed
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
      
      // Handle different event types
      switch(event.event) {
        case 'charge.success':
          // Handle successful charge
          console.log('Payment successful:', event.data);
          break;
        
        case 'transfer.success':
          // Handle successful transfer
          console.log('Transfer successful:', event.data);
          break;
        
        default:
          // Handle other events
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

app.listen(port, () => {
  console.log(`Payment server running on port ${port}`);
}); 