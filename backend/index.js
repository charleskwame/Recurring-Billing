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

// CyberSource indexes a completed payment asynchronously. Until that finishes, the recurring
// billing service rejects an otherwise valid follow-on request with 400 INVALID_DATA / 404
// NOT_FOUND, so those responses are transient and must be retried. The delays grow geometrically
// and total ~3.5s so the whole call stays inside a serverless function timeout.
const FOLLOW_ON_RETRY_DELAYS_MS = [500, 1000, 2000]; // Delays in milliseconds between retry attempts
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

//Actual Function That Creates the Subscription
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

// Upstream statuses that always describe a temporary condition.
const TRANSIENT_FOLLOW_ON_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// 400/404 reasons CyberSource returns while the original transaction is still being indexed.
const TRANSIENT_FOLLOW_ON_REASONS = new Set(["INVALID_DATA", "NOT_FOUND", "NOT_AVAILABLE", "SYSTEM_ERROR", "SERVER_ERROR", "TIMEOUT"]);

// Returns TRUE when the failure is worth retrying, FALSE when the request itself is the problem.
// A 400/404 that carries a details array is only retryable when its reason is a known transient
// one; a transient reason must still be retried even though it includes details.
const shouldRetryFollowOnSubscription = (upstreamStatus, upstreamResponseData) => {
  if (TRANSIENT_FOLLOW_ON_STATUSES.has(upstreamStatus)) {
    return true;
  }

  if (upstreamStatus !== 400 && upstreamStatus !== 404) {
    return false;
  }

  const details = upstreamResponseData?.details;
  const reasons = [upstreamResponseData?.reason, ...(Array.isArray(details) ? details.map((detail) => detail?.reason) : [])]
    .map((reason) => String(reason || "").toUpperCase())
    .filter(Boolean);

  // With no reason to act on, treat the response as transient and retry.
  if (reasons.length === 0) {
    return true;
  }

  // A field-level validation failure can never succeed on a retry, no matter how long we wait.
  if (reasons.includes("REQUIRED")) {
    return false;
  }

  return reasons.some((reason) => TRANSIENT_FOLLOW_ON_REASONS.has(reason));
};

const createFollowOnSubscriptionWithRetry = async (transactionId, plan) => {
  for (let attempt = 1; attempt <= FOLLOW_ON_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await createFollowOnSubscription(transactionId, plan);
    } catch (error) {
      const upstreamStatusCode = error.response?.status || 500;
      const upstreamResponseData = error.response?.data ?? null;
      const retryable = shouldRetryFollowOnSubscription(upstreamStatusCode, upstreamResponseData);

      console.error(
        `Recurring billing attempt ${attempt}/${FOLLOW_ON_MAX_ATTEMPTS} failed (status ${upstreamStatusCode}, retryable: ${retryable}):`,
        upstreamResponseData || error.message,
      );

      if (attempt === FOLLOW_ON_MAX_ATTEMPTS || !retryable) {
        throw error;
      }

      await sleep(FOLLOW_ON_RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  // Unreachable: the loop either returns the subscription or throws the last error.
  throw new Error("Follow-on subscription retry loop exited unexpectedly.");
};

//Verify the JWT, extract the transaction ID, and create a follow-on subscription with retry logic
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

    const response = await createFollowOnSubscriptionWithRetry(transactionId, plan);

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

console.log(`Backend server started at ${new Date().toISOString()}`);

if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
