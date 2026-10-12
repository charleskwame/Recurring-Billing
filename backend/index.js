const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createHeaders } = require("cybersource-auth");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const allowedOrigins = ["https://recurring-billing-frontend.vercel.app", process.env.FRONTEND_ORIGIN].filter(Boolean);
const SESSION_COOKIE = "recurring_billing_session";
const CHECKOUT_COOKIE = "recurring_billing_checkout";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const CHECKOUT_MAX_AGE_SECONDS = 60 * 15;
const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;
let mongoClientPromise;
let usersCollectionPromise;

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
    credentials: true,
  }),
);

app.use(express.json());

const HOST = process.env.CYBERSOURCE_HOST;
const MERCHANT_ID = process.env.CYBERSOURCE_MERCHANT_ID;
const API_KEY_ID = process.env.CYBERSOURCE_API_KEY_ID;
const SHARED_SECRET = process.env.CYBERSOURCE_API_SECRET_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || "recurringBilling";
const SESSION_SECRET = process.env.SESSION_SECRET;
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

const parseCookies = (cookieHeader = "") =>
  cookieHeader.split(";").reduce((cookies, cookie) => {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex === -1) return cookies;
    const name = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();
    cookies[name] = decodeURIComponent(value);
    return cookies;
  }, {});

const cookieOptions = (maxAge) =>
  [
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    process.env.NODE_ENV === "production" ? "SameSite=None" : "SameSite=Lax",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");

const setSignedCookie = (res, name, payload, maxAge) => {
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET is not configured.");
  const token = jwt.sign(payload, SESSION_SECRET, { expiresIn: maxAge });
  res.append("Set-Cookie", `${name}=${encodeURIComponent(token)}; ${cookieOptions(maxAge)}`);
};

const clearCookie = (res, name) => {
  res.append("Set-Cookie", `${name}=; ${cookieOptions(0)}`);
};

const getSignedCookie = (req, name) => {
  if (!SESSION_SECRET) return null;
  const token = parseCookies(req.headers.cookie)[name];
  if (!token) return null;
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch {
    return null;
  }
};

const getUsersCollection = async () => {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not configured.");
  if (!mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI);
    mongoClientPromise = client.connect();
  }
  const client = await mongoClientPromise;
  if (!usersCollectionPromise) {
    usersCollectionPromise = (async () => {
      const collection = client.db(MONGODB_DATABASE).collection("users");
      await collection.createIndex({ username: 1 }, { unique: true });
      return collection;
    })();
  }
  return usersCollectionPromise;
};

const normalizeUsername = (username) => (typeof username === "string" ? username.trim().toLowerCase() : "");

const validateCredentials = (username, password) => {
  const normalizedUsername = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return { error: "Username must be 3-32 characters using letters, numbers, or underscores." };
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
    return { error: "Password must be between 8 and 128 characters." };
  }
  return { username: normalizedUsername, password };
};

const publicUser = (user) => ({ username: user.username, hasSubscription: Boolean(user.subscriptionId) });

const issueSession = (res, user) =>
  setSignedCookie(res, SESSION_COOKIE, { userId: user._id.toString(), username: user.username }, SESSION_MAX_AGE_SECONDS);

const requireAuth = async (req, res, next) => {
  try {
    const session = getSignedCookie(req, SESSION_COOKIE);
    if (!session?.userId) return res.status(401).json({ error: "Please create an account or log in first." });
    const users = await getUsersCollection();
    const user = await users.findOne({ _id: new ObjectId(session.userId) });
    if (!user) return res.status(401).json({ error: "Your session is no longer valid. Please log in again." });
    req.user = user;
    return next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    return res.status(500).json({ error: "Account service is temporarily unavailable." });
  }
};

const checkAccountConfiguration = () => Boolean(MONGODB_URI && SESSION_SECRET);

const createAccount = async (req, res) => {
  const credentials = validateCredentials(req.body?.username, req.body?.password);
  if (credentials.error) return res.status(400).json({ error: credentials.error });
  if (!checkAccountConfiguration()) return res.status(500).json({ error: "Account service is not fully configured." });
  try {
    const users = await getUsersCollection();
    const passwordHash = await bcrypt.hash(credentials.password, 12);
    const result = await users.insertOne({ username: credentials.username, passwordHash, subscriptionId: null });
    const user = { _id: result.insertedId, username: credentials.username, subscriptionId: null };
    issueSession(res, user);
    return res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: "That username is already in use." });
    console.error("Account creation error:", error.message);
    return res.status(500).json({ error: "Unable to create the account." });
  }
};

const login = async (req, res) => {
  const credentials = validateCredentials(req.body?.username, req.body?.password);
  if (credentials.error) return res.status(400).json({ error: credentials.error });
  if (!checkAccountConfiguration()) return res.status(500).json({ error: "Account service is not fully configured." });
  try {
    const users = await getUsersCollection();
    const user = await users.findOne({ username: credentials.username });
    const validPassword = user && (await bcrypt.compare(credentials.password, user.passwordHash));
    if (!validPassword) return res.status(401).json({ error: "Invalid username or password." });
    issueSession(res, user);
    return res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({ error: "Unable to log in." });
  }
};

const currentUser = (req, res) => res.json({ user: publicUser(req.user) });

const logout = (req, res) => {
  clearCookie(res, SESSION_COOKIE);
  clearCookie(res, CHECKOUT_COOKIE);
  return res.status(204).send();
};

const createCheckoutSession = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Please create an account or log in first." });
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

    setSignedCookie(res, CHECKOUT_COOKIE, { userId: req.user._id.toString(), planKey: req.body.planKey }, CHECKOUT_MAX_AGE_SECONDS);

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

const shouldRetryFollowOnSubscription = (upstreamStatus, upstreamResponseData) => {
  if (upstreamStatus === 502 || upstreamStatus === 503 || upstreamStatus === 504) {
    return true;
  }

  if (upstreamStatus !== 400 && upstreamStatus !== 404) {
    return false;
  }

  return !Array.isArray(upstreamResponseData?.details) || upstreamResponseData.details.length === 0;

  //returns TRUE if the error is retryable, FALSE otherwise
  // For example, if the error is a 400 or 404 with details, it is not retryable
};

const createFollowOnSubscriptionWithRetry = async (transactionId, plan) => {
  for (let retryAttempt = 0; retryAttempt <= FOLLOW_ON_RETRY_DELAYS_MS.length; retryAttempt += 1) {
    try {
      return await createFollowOnSubscription(transactionId, plan);
    } catch (error) {
      const upstreamStatusCode = error.response?.status || 500;
      const upstreamResponseData = error.response?.data ?? null;

      console.error("Recurring billing error:", upstreamResponseData || error.message);

      if (retryAttempt === FOLLOW_ON_RETRY_DELAYS_MS.length || !shouldRetryFollowOnSubscription(upstreamStatusCode, upstreamResponseData)) {
        throw error;
      }

      await sleep(FOLLOW_ON_RETRY_DELAYS_MS[retryAttempt]);
    }
  }
  //returns the subscription response or throws the final error
};

//Verify the JWT, extract the transaction ID, and create a follow-on subscription with retry logic
const activateRecurringBilling = async (req, res) => {
  try {
    const checkout = getSignedCookie(req, CHECKOUT_COOKIE);
    if (!checkout || checkout.userId !== req.user._id.toString() || checkout.planKey !== req.body?.planKey) {
      return res.status(400).json({ error: "The checkout session is invalid or expired." });
    }

    const decoded = decodeJwtPayload(req.body?.result);
    const transactionId = decoded?.id;
    const plan = getPlan(checkout.planKey);

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
    const subscriptionId = response?.data?.id || response?.data?.subscriptionId;
    if (!subscriptionId) {
      return res.status(502).json({ error: "CyberSource did not return a subscription ID." });
    }

    const users = await getUsersCollection();
    const update = await users.updateOne({ _id: req.user._id, subscriptionId: null }, { $set: { subscriptionId } });
    if (update.modifiedCount !== 1) {
      return res.status(409).json({ error: "This account already has a subscription." });
    }
    clearCookie(res, CHECKOUT_COOKIE);

    return res.json({
      success: true,
      subscriptionId,
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

app.post("/account/signup", createAccount);
app.post("/account/login", login);
app.get("/account/me", requireAuth, currentUser);
app.post("/account/logout", logout);
app.post("/activate-recurring-billing", requireAuth, activateRecurringBilling);

app.post("/checkout-session", requireAuth, createCheckoutSession);

console.log(`Backend server started at ${new Date().toISOString()}`);

if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
