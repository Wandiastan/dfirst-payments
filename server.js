const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const https = require('https');
const fetch = require('node-fetch');
const moment = require('moment');

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

// M-Pesa API helper
const mpesaAPI = {
  getAccessToken: async () => {
    try {
      const auth = Buffer.from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
      ).toString('base64');

      const response = await fetch(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        {
          method: 'GET',
          headers: {
            Authorization: `Basic ${auth}`
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to get access token');
      }

      const data = await response.json();
      return data.access_token;
    } catch (error) {
      console.error('M-Pesa access token error:', error);
      throw error;
    }
  },

  initiateSTKPush: async (phoneNumber, amount, accountReference) => {
    try {
      const token = await mpesaAPI.getAccessToken();
      const timestamp = moment().format('YYYYMMDDHHmmss');
      const password = Buffer.from(
        `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
      ).toString('base64');

      const response = await fetch(
        'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            BusinessShortCode: process.env.MPESA_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.round(amount),
            PartyA: phoneNumber,
            PartyB: process.env.MPESA_SHORTCODE,
            PhoneNumber: phoneNumber,
            CallBackURL: process.env.MPESA_CALLBACK_URL,
            AccountReference: accountReference,
            TransactionDesc: 'DFirst Bot Payment'
          })
        }
      );

      if (!response.ok) {
        throw new Error('STK push request failed');
      }

      return response.json();
    } catch (error) {
      console.error('M-Pesa STK push error:', error);
      throw error;
    }
  },

  querySTKStatus: async (checkoutRequestId) => {
    try {
      const token = await mpesaAPI.getAccessToken();
      const timestamp = moment().format('YYYYMMDDHHmmss');
      const password = Buffer.from(
        `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
      ).toString('base64');

      const response = await fetch(
        'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            BusinessShortCode: process.env.MPESA_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            CheckoutRequestID: checkoutRequestId
          })
        }
      );

      if (!response.ok) {
        throw new Error('STK query request failed');
      }

      return response.json();
    } catch (error) {
      console.error('M-Pesa STK query error:', error);
      throw error;
    }
  }
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

// M-Pesa payment initialization endpoint
app.post('/payment/mpesa/initiate', async (req, res) => {
  try {
    const { phoneNumber, amount, metadata } = req.body;

    if (!phoneNumber || !amount) {
      return res.status(400).json({
        status: false,
        message: 'Phone number and amount are required'
      });
    }

    console.log('Initializing M-Pesa payment with data:', {
      phoneNumber,
      amount,
      metadata
    });

    const response = await mpesaAPI.initiateSTKPush(
      phoneNumber,
      amount,
      metadata.userId
    );

    // Store metadata for callback processing
    const requestKey = `mpesa_request_${response.CheckoutRequestID}`;
    global[requestKey] = {
      metadata,
      amount,
      timestamp: new Date()
    };

    res.json({
      status: true,
      data: {
        checkoutRequestID: response.CheckoutRequestID,
        merchantRequestID: response.MerchantRequestID,
        responseCode: response.ResponseCode,
        customerMessage: response.CustomerMessage
      }
    });
  } catch (error) {
    console.error('M-Pesa payment initialization error:', error);
    res.status(500).json({
      status: false,
      message: error.message || 'Failed to initiate M-Pesa payment'
    });
  }
});

// M-Pesa payment verification endpoint
app.get('/payment/mpesa/verify/:checkoutRequestId', async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;
    
    if (!checkoutRequestId) {
      throw new Error('No checkout request ID provided');
    }

    // Check cached verification result
    const verificationKey = `mpesa_verification_${checkoutRequestId}`;
    if (global[verificationKey]) {
      console.log('Payment already verified:', checkoutRequestId);
      return res.json(global[verificationKey]);
    }

    console.log('Verifying M-Pesa payment:', checkoutRequestId);
    const response = await mpesaAPI.querySTKStatus(checkoutRequestId);
    
    // Process the response
    const success = response.ResultCode === '0';
    const requestKey = `mpesa_request_${checkoutRequestId}`;
    const requestData = global[requestKey];
    
    const result = {
      status: success,
      data: {
        checkoutRequestID: checkoutRequestId,
        resultCode: response.ResultCode,
        resultDesc: response.ResultDesc,
        metadata: requestData?.metadata
      }
    };

    // Cache verification result
    global[verificationKey] = result;
    
    // Clear request data
    delete global[requestKey];
    
    // Clear verification cache after 5 minutes
    setTimeout(() => {
      delete global[verificationKey];
    }, 5 * 60 * 1000);

    res.json(result);
  } catch (error) {
    console.error('M-Pesa payment verification error:', error);
    res.status(500).json({
      status: false,
      message: error.message || 'Payment verification failed'
    });
  }
});

// M-Pesa callback endpoint
app.post('/mpesa/callback', async (req, res) => {
  try {
    const { Body } = req.body;
    const { stkCallback } = Body;
    
    console.log('M-Pesa callback received:', stkCallback);
    
    const verificationKey = `mpesa_verification_${stkCallback.CheckoutRequestID}`;
    const requestKey = `mpesa_request_${stkCallback.CheckoutRequestID}`;
    const requestData = global[requestKey];
    
    if (stkCallback.ResultCode === 0) {
      // Payment successful
      const callbackMetadata = stkCallback.CallbackMetadata.Item;
      const amount = callbackMetadata.find(item => item.Name === 'Amount').Value;
      const mpesaReceiptNumber = callbackMetadata.find(item => item.Name === 'MpesaReceiptNumber').Value;
      const phoneNumber = callbackMetadata.find(item => item.Name === 'PhoneNumber').Value;
      
      // Cache verification result
      global[verificationKey] = {
        status: true,
        data: {
          amount,
          receipt: mpesaReceiptNumber,
          phoneNumber,
          checkoutRequestID: stkCallback.CheckoutRequestID,
          metadata: requestData?.metadata
        }
      };
    } else {
      // Payment failed
      global[verificationKey] = {
        status: false,
        error: stkCallback.ResultDesc,
        data: {
          checkoutRequestID: stkCallback.CheckoutRequestID,
          metadata: requestData?.metadata
        }
      };
    }
    
    res.json({ status: 'success' });
  } catch (error) {
    console.error('M-Pesa callback error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
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

// Start server
app.listen(port, async () => {
  console.log(`Payment server running on port ${port}`);
  
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    console.log('\nPayment Gateway Configuration:');
    console.log('-----------------------------------');
    console.log('1. Server IP:', data.ip);
    console.log('\n2. Render.com IPs for Paystack:');
    console.log('   - 35.196.132.4');
    console.log('   - 35.196.132.8');
    console.log('   - 35.196.132.12');
    console.log('   - 35.196.132.16');
    console.log('\n3. M-Pesa Configuration:');
    console.log('   Callback URL:', process.env.MPESA_CALLBACK_URL);
    console.log('-----------------------------------\n');
  } catch (error) {
    console.error('Failed to get server IP:', error);
  }
}); 