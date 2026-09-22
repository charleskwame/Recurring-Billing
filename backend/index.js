const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createHeaders } = require("cybersource-auth");
const axios = require("axios");

const app = express();
const allowedOrigins = ["https://recurring-billing-frontend.vercel.app", process.env.FRONTEND_ORIGIN]
  .filter(Boolean)
  .map((origin) => origin.replace(/\/+$/, ""));

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed by CORS."));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

const HOST = process.env.CYBERSOURCE_HOST;
const MERCHANT_ID = process.env.CYBERSOURCE_MERCHANT_ID;
const API_KEY_ID = process.env.CYBERSOURCE_API_KEY_ID;
const SHARED_SECRET = process.env.CYBERSOURCE_API_SECRET_KEY;
const TOKEN_RESOURCE_PATH = process.env.CYBERSOURCE_TOKEN_URI;
const SUBSCRIPTION_RESOURCE_PATH = process.env.CYBERSOURCE_SUBSCRIPTION_URI;
const INSTRUMENT_IDENTIFIER_URI = process.env.CYBERSOURCE_INSTRUMENT_IDENTIFIER_URI;

const createDailySubscription = async (req, res) => {
  try {
    if (!HOST || !MERCHANT_ID || !API_KEY_ID || !SHARED_SECRET) {
      return res.status(500).json({
        error: "CyberSource environment variables are not fully configured.",
      });
    }

    // return res.json(req.body);

    const normalizedHost = HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const url = `https://${normalizedHost}${TOKEN_RESOURCE_PATH}`;

    const rawBody = JSON.stringify(req.body);

    const headers = createHeaders(MERCHANT_ID, normalizedHost, "post", TOKEN_RESOURCE_PATH, rawBody, API_KEY_ID, SHARED_SECRET);

    const response = await axios.post(url, req.body, { headers, timeout: 10000 });

    const customerTokenResponse = response.data;

    if (!customerTokenResponse) {
      return res.status(500).json({
        error: "CyberSource returned a 200 response, but no token was generated.",
        responseHeaders: response.headers,
        rawResponse: response.data,
      });
    }

    const customerId = customerTokenResponse.id;

    if (!customerId) {
      return res.status(500).json({
        error: "Failed to retrieve Customer ID from token response.",
      });
    }

    // return res.json(customerTokenResponse)

    // Extract card and billTo from request
    const cardData = req.body.paymentInformation?.card || req.body.card;
    const billToData = req.body.billTo;

    if (!cardData || !cardData.number) {
      return res.status(400).json({ error: "Card number is missing in the payload." });
    }

    // --- Step 2: Create Instrument Identifier ---
    // const instrumentIdentifierPath = "/tms/v1/instrumentidentifiers";
    const instrumentIdentifierUrl = `https://${normalizedHost}${INSTRUMENT_IDENTIFIER_URI}`;

    const instrumentIdentifierPayload = {
      card: {
        number: cardData.number,
      },
    };

    const rawInstrumentIdentifierBody = JSON.stringify(instrumentIdentifierPayload);
    const instrumentIdentifierHeaders = createHeaders(
      MERCHANT_ID,
      normalizedHost,
      "post",
      INSTRUMENT_IDENTIFIER_URI,
      rawInstrumentIdentifierBody,
      API_KEY_ID,
      SHARED_SECRET,
    );

    let instrumentIdentifierId;
    try {
      const instrumentIdentifierResponse = await axios.post(instrumentIdentifierUrl, instrumentIdentifierPayload, {
        headers: instrumentIdentifierHeaders,
        timeout: 10000,
      });
      instrumentIdentifierId = instrumentIdentifierResponse.data.id;
    } catch (error) {
      console.error("Instrument Identifier Error:", error.response?.data || error.message);
      throw new Error(error.response?.data?.message || "Failed to create Instrument Identifier");
    }
    // return res.json(instrumentIdentifierId);

    // --- Step 3: Create Payment Instrument ---
    const paymentInstrumentsLink = customerTokenResponse._links.paymentInstruments.href;
    const paymentInstrumentUrl = `https://${normalizedHost}${paymentInstrumentsLink}`;

    const paymentInstrumentPayload = {
      card: {
        expirationMonth: cardData.expirationMonth,
        expirationYear: cardData.expirationYear,
        type: cardData.type,
      },
      billTo: billToData,
      instrumentIdentifier: {
        id: instrumentIdentifierId,
      },
    };

    const rawPaymentInstrumentBody = JSON.stringify(paymentInstrumentPayload);
    const paymentInstrumentHeaders = createHeaders(
      MERCHANT_ID,
      normalizedHost,
      "post",
      paymentInstrumentsLink,
      rawPaymentInstrumentBody,
      API_KEY_ID,
      SHARED_SECRET,
    );

    const paymentInstrumentResponse = await axios.post(paymentInstrumentUrl, paymentInstrumentPayload, {
      headers: paymentInstrumentHeaders,
      timeout: 10000,
    });

    const paymentInstrumentTokenResponse = paymentInstrumentResponse.data;

    if (!paymentInstrumentTokenResponse) {
      return res.status(500).json({
        error: "CyberSource returned a 200 response, but no token was generated.",
        responseHeaders: paymentInstrumentResponse.headers,
        rawResponse: paymentInstrumentResponse.data,
      });
    }

    // const paymentInstrumentToken = paymentInstrumentTokenResponse;
    // return res.json(paymentInstrumentTokenResponse)

    const subscriptionData = {
      clientReferenceInformation: {
        code: `subscription_${Date.now()}`,
      },
      subscriptionInformation: {
        planId: "7896588237846374604803",
        name: "Daily 20 Test",
        startDate: `${new Date().toISOString()}`,
      },
      paymentInformation: {
        customer: {
          id: customerId,
        },
      },
    };

    // return res.json(subscriptionData)

    const rawSubscriptionBody = JSON.stringify(subscriptionData);
    const subscriptionUrl = `https://${normalizedHost}${SUBSCRIPTION_RESOURCE_PATH}`;
    const subscriptionHeaders = createHeaders(
      MERCHANT_ID,
      normalizedHost,
      "post",
      SUBSCRIPTION_RESOURCE_PATH,
      rawSubscriptionBody,
      API_KEY_ID,
      SHARED_SECRET,
    );

    const subscriptionResponse = await axios.post(subscriptionUrl, subscriptionData, { headers: subscriptionHeaders, timeout: 10000 });

    return res.json(subscriptionResponse.data);
  } catch (error) {
    console.error("CyberSource API Error:", error.response?.data || error.message);

    if (error.response) {
      return res.status(error.response.status).json({
        error: error.response.data?.message || "CyberSource request failed",
        details: error.response.data,
      });
    }

    return res.status(500).json({ error: error.message });
  }
};

app.post("/subscribe-daily", createDailySubscription);

if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
