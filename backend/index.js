const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createHeaders } = require("cybersource-auth");
// const jwt = require("jsonwebtoken");
const axios = require("axios");

const app = express();
const allowedOrigins = ["https://recurring-billing-frontend.vercel.app", process.env.FRONTEND_ORIGIN].filter(Boolean);

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
const RECURRING_PLAN_ID = process.env.CYBERSOURCE_RECURRING_PLAN_ID;
const resourcePath = "/uc/v1/sessions";
const subscriptionResourcePath = process.env.SUBSCRIPTION_RESOURCE_PATH || "/rbs/v1/subscriptions";

// Format required by the Subscriptions API: YYYY-MM-DDThh:mm:ssZ
const formatSubscriptionStartDate = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

const decodeJwtPayload = (token) => {
  try {
    if (!token || typeof token !== "string") {
      throw new Error("JWT is empty or invalid.");
    }

    const parts = token.split(".");

    if (parts.length !== 3) {
      throw new Error("Invalid JWT format.");
    }

    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");

    const json = Buffer.from(base64, "base64").toString("utf8");

    return JSON.parse(json);
  } catch (error) {
    console.error("Failed to decode JWT:", error);
    return null;
  }
};

const normalizedHost = HOST ? HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";

const createCheckoutSession = async (req, res) => {
  try {
    if (!HOST || !MERCHANT_ID || !API_KEY_ID || !SHARED_SECRET) {
      return res.status(500).json({
        error: "CyberSource environment variables are not fully configured.",
      });
    }

    const url = `https://${normalizedHost}${resourcePath}`;

    const rawPayload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : req.body;
    const payload = normalizeCheckoutPayload(rawPayload);

    const validationErrors = validateCheckoutPayload(payload);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: "Invalid checkout-session payload.",
        validationErrors,
      });
    }

    const rawBody = JSON.stringify(payload);

    const headers = createHeaders(MERCHANT_ID, normalizedHost, "post", resourcePath, rawBody, API_KEY_ID, SHARED_SECRET);

    const response = await axios.post(url, payload, { headers, timeout: 10000 });

    const captureContext = response.data;

    if (!captureContext) {
      return res.status(500).json({
        error: "CyberSource returned a 200 response, but no Capture Context token was generated.",
        responseHeaders: response.headers,
        rawResponse: response.data,
      });
    }

    return res.json(captureContext);
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

const validateCheckoutPayload = (payload) => {
  const errors = [];

  if (!Array.isArray(payload.targetOrigins) || payload.targetOrigins.length === 0) {
    errors.push("targetOrigins must be a non-empty array.");
  }

  if (typeof payload.clientVersion !== "string" || payload.clientVersion.trim().length === 0) {
    errors.push("clientVersion is required.");
  }

  if (typeof payload.country !== "string" || payload.country.trim().length === 0) {
    errors.push("country is required.");
  }

  if (typeof payload.locale !== "string" || payload.locale.trim().length === 0) {
    errors.push("locale is required.");
  }

  const orderInfo = payload.data?.orderInformation || payload.orderInformation;

  if (typeof orderInfo !== "object" || orderInfo === null || typeof orderInfo.amountDetails !== "object" || orderInfo.amountDetails === null) {
    errors.push("data.orderInformation.amountDetails is required.");
    return errors;
  }

  const amountDetails = orderInfo.amountDetails;

  if (typeof amountDetails.totalAmount !== "string" || amountDetails.totalAmount.trim().length === 0) {
    errors.push("data.orderInformation.amountDetails.totalAmount is required.");
  }

  if (typeof amountDetails.currency !== "string" || amountDetails.currency.trim().length === 0) {
    errors.push("data.orderInformation.amountDetails.currency is required.");
  }

  return errors;
};

const normalizeCheckoutPayload = (rawPayload) => {
  const payload = rawPayload && typeof rawPayload === "object" ? { ...rawPayload } : {};

  if (typeof payload.data !== "object" || payload.data === null) {
    payload.data = {};
  }

  if (payload.orderInformation && !payload.data.orderInformation) {
    payload.data.orderInformation = payload.orderInformation;
  }

  delete payload.orderInformation;
  return payload;
};

const verifyPaymentResult = async (req, res) => {
  try {
    const { completeResponse } = req.body;

    if (!completeResponse) {
      return res.status(400).json({
        error: "completeResponse JWT is required",
      });
    }

    const decoded = decodeJwtPayload(completeResponse);

    if (!decoded) {
      return res.status(400).json({
        error: "Unable to decode payment result JWT",
      });
    }

    console.log("Decoded payment result:", decoded);

    return res.status(200).json({
      success: true,
      decoded,
    });
  } catch (error) {
    console.error("Payment result error:", error);

    return res.status(500).json({
      error: "Failed to process payment result",
    });
  }
};

const createFollowOnSubscription = (transactionId) => {
  const subscriptionData = {
    clientReferenceInformation: {
      code: `subscription_${Date.now()}`,
    },
    subscriptionInformation: {
      planId: RECURRING_PLAN_ID,
      name: "Daily 20 Test",
      startDate: formatSubscriptionStartDate(),
    },
  };

  const rawBody = JSON.stringify(subscriptionData);
  const rbsResourcePath = `${subscriptionResourcePath}/follow-ons/${transactionId}`;

  // Generate authentication headers
  const headers = createHeaders(MERCHANT_ID, normalizedHost, "post", rbsResourcePath, rawBody, API_KEY_ID, SHARED_SECRET);

  return axios.post(`https://${normalizedHost}${rbsResourcePath}`, rawBody, { headers, timeout: 10000 });
};

const activateRecurringBilling = async (req, res) => {
  try {
    const decoded = decodeJwtPayload(req.body?.result);
    const transactionId = decoded?.id;

    if (!transactionId) {
      return res.status(400).json({
        error: "Transaction ID is missing from the decoded result",
      });
    }

    if (!RECURRING_PLAN_ID) {
      return res.status(500).json({
        error: "CYBERSOURCE_RECURRING_PLAN_ID is not configured.",
      });
    }

    const response = await createFollowOnSubscription(transactionId);

    return res.json({
      success: true,
      response: response?.data,
    });
  } catch (error) {
    const upstreamStatus = error.response?.status || 500;
    const upstreamData = error.response?.data ?? null;

    console.error("Recurring billing error:", upstreamData || error.message);

    return res.status(upstreamStatus).json({
      error: upstreamData?.message || "Failed to process recurring billing",
      details: upstreamData,
    });
  }
};

app.post("/activate-recurring-billing", activateRecurringBilling);

app.post("/checkout-session", createCheckoutSession);

app.post("/verify-payment", verifyPaymentResult);

console.log(`Backend server started at ${new Date().toISOString()}`);

if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
