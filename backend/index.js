const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createHeaders } = require("cybersource-auth");
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
const resourcePath = "/uc/v1/sessions";
const subscriptionResourcePath = process.env.SUBSCRIPTION_RESOURCE_PATH || "/rbs/v1/subscriptions";
const PLANS = {
  daily: {
    id: process.env.CYBERSOURCE_RECURRING_PLAN_ID,
    name: "Daily 20 Test",
    amount: "20.00",
    interval: "day",
  },
  weekly: {
    id: "7906006439496154804804",
    name: "Weekly 50 Test",
    amount: "50.00",
    interval: "week",
  },
  monthly: {
    id: "7906006786536213404801",
    name: "Monthly 100 test",
    amount: "100.00",
    interval: "month",
  },
};
const FOLLOW_ON_RETRY_DELAYS_MS = [300, 500, 1000]; // Delays in milliseconds for retry attempts

const FOLLOW_ON_MAX_ATTEMPTS = FOLLOW_ON_RETRY_DELAYS_MS.length + 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const getPlan = (planKey) => {
  const plan = PLANS[planKey];

  if (!plan?.id) {
    return null;
  }

  return plan;
};

const createCheckoutSession = async (req, res) => {
  try {
    if (!HOST || !MERCHANT_ID || !API_KEY_ID || !SHARED_SECRET) {
      return res.status(500).json({
        error: "CyberSource environment variables are not fully configured.",
      });
    }

    const url = `https://${normalizedHost}${resourcePath}`;

    const plan = getPlan(req.body?.planKey);

    if (!plan) {
      return res.status(400).json({ error: "A valid subscription plan is required." });
    }

    const { planKey, ...checkoutPayload } = req.body;
    checkoutPayload.data = {
      ...checkoutPayload.data,
      orderInformation: {
        ...checkoutPayload.data?.orderInformation,
        amountDetails: {
          ...checkoutPayload.data?.orderInformation?.amountDetails,
          totalAmount: plan.amount,
          currency: "USD",
        },
      },
    };
    const rawBody = JSON.stringify(checkoutPayload);

    const headers = createHeaders(MERCHANT_ID, normalizedHost, "post", resourcePath, rawBody, API_KEY_ID, SHARED_SECRET);

    const response = await axios.post(url, checkoutPayload, { headers, timeout: 10000 });

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

const createFollowOnSubscription = (transactionId, plan) => {
  const subscriptionData = {
    clientReferenceInformation: {
      code: `subscription_${transactionId}`,
    },
    subscriptionInformation: {
      planId: plan.id,
      name: plan.name,
      startDate: formatSubscriptionStartDate(),
    },
  };

  const rawBody = JSON.stringify(subscriptionData);
  const rbsResourcePath = `${subscriptionResourcePath}/follow-ons/${transactionId}`;

  const headers = createHeaders(MERCHANT_ID, normalizedHost, "post", rbsResourcePath, rawBody, API_KEY_ID, SHARED_SECRET);

  return axios.post(`https://${normalizedHost}${rbsResourcePath}`, rawBody, { headers, timeout: 10000 });
};

const isFollowOnRetryable = (status, data) => {
  if (status === 502 || status === 503 || status === 504) {
    return true;
  }

  if (status !== 400 && status !== 404) {
    return false;
  }

  return !Array.isArray(data?.details) || data.details.length === 0;
};

const activateRecurringBilling = async (req, res) => {
  try {
    const decoded = decodeJwtPayload(req.body?.result);
    const transactionId = decoded?.id;
    const plan = getPlan(req.body?.planKey);

    if (!transactionId) {
      return res.status(400).json({
        error: "Transaction ID is missing from the decoded result",
      });
    }

    if (!plan) {
      return res.status(400).json({
        error: "A valid subscription plan is required.",
      });
    }

    let lastError;

    for (let attempt = 1; attempt <= FOLLOW_ON_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await createFollowOnSubscription(transactionId, plan);

        return res.json({
          success: true,
          response: response?.data,
        });
      } catch (error) {
        lastError = error;

        const upstreamStatus = error.response?.status || 500;
        const upstreamData = error.response?.data ?? null;
        const canRetry = attempt < FOLLOW_ON_MAX_ATTEMPTS && isFollowOnRetryable(upstreamStatus, upstreamData);

        console.error("Recurring billing error:", upstreamData || error.message);

        if (!canRetry) {
          break;
        }

        await sleep(FOLLOW_ON_RETRY_DELAYS_MS[attempt - 1]);
      }
    }

    const upstreamStatus = lastError.response?.status || 500;
    const upstreamData = lastError.response?.data ?? null;

    return res.status(upstreamStatus).json({
      error: upstreamData?.message || "Failed to process recurring billing",
      details: upstreamData,
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

console.log(`Backend server started at ${new Date().toISOString()}`);

if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
