const BACKEND_URL = "https://recurring-billing-backend.vercel.app";

const planButtons = document.querySelectorAll(".plan-button");
const checkoutSidebar = document.getElementById("checkoutSidebar");
const closeCheckoutButton = document.getElementById("closeCheckout");
const statusMessage = document.getElementById("statusMessage");
const successDialog = document.getElementById("successDialog");
const subscriptionResult = document.getElementById("subscriptionResult");
const closeSuccessDialogButton = document.getElementById("closeSuccessDialog");
const accountForm = document.getElementById("accountForm");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const accountSubmit = document.getElementById("accountSubmit");
const accountMode = document.getElementById("accountMode");
const accountMessage = document.getElementById("accountMessage");
const accountDescription = document.getElementById("accountDescription");
const signedInState = document.getElementById("signedInState");
const signedInUsername = document.getElementById("signedInUsername");
const logoutButton = document.getElementById("logoutButton");
const checkoutOrigin = window.location.origin === "null" ? "https://recurring-billing-frontend.vercel.app" : window.location.origin;
let accountModeIsLogin = false;
let currentAccount = null;

const activateRecurringBilling = async (result, planKey) => {
  return axios.post(
    `${BACKEND_URL}/activate-recurring-billing`,
    {
      result,
      planKey,
    },
    { withCredentials: true },
  );
};

const paymentPayload = (planKey) => ({
  planKey,
  targetOrigins: [checkoutOrigin],
  clientVersion: "1.0",
  country: "US",
  locale: "en_US",
  data: {
    orderInformation: {
      amountDetails: {
        totalAmount: "0.00",
        currency: "USD",
      },
    },
  },
});

const decodeJwtPayload = (jwt) => {
  try {
    if (!jwt || typeof jwt !== "string") {
      throw new Error("JWT is empty or invalid.");
    }

    const parts = jwt.split(".");

    if (parts.length !== 3) {
      throw new Error("Invalid JWT format.");
    }

    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");

    while (base64.length % 4) {
      base64 += "=";
    }

    const json = atob(base64);

    return JSON.parse(json);
  } catch (error) {
    console.error("Failed to decode JWT:", error);
    return null;
  }
};

const loadCyberSourceSdk = (clientLibrary, integrity) => {
  return new Promise((resolve, reject) => {
    if (!clientLibrary) {
      reject(new Error("CyberSource clientLibrary URL is missing."));
      return;
    }

    if (typeof window.Accept === "function" || window.VAS) {
      resolve();
      return;
    }

    const script = document.createElement("script");

    script.type = "text/javascript";
    script.async = false;
    script.src = clientLibrary;

    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = "anonymous";
    }

    script.onload = () => {
      resolve();
    };

    script.onerror = () => {
      reject(new Error("CyberSource SDK failed to load."));
    };

    document.head.appendChild(script);
  });
};

const startWithVAS = async (captureContext, planKey) => {
  let client = null;
  let checkout = null;

  try {
    client = await window.VAS.UnifiedCheckout(captureContext);
    checkout = await client.createCheckout({
      autoProcessing: true,
    });

    const result = await checkout.mount({
      paymentSelection: "#buttonPaymentListContainer",
      paymentScreen: "#embeddedPaymentContainer",
    });

    if (result) {
      const response = await activateRecurringBilling(result, planKey);

      statusMessage.textContent = "Subscription created successfully.";
      subscriptionResult.textContent = JSON.stringify({ subscriptionId: response.data.subscriptionId }, null, 2);
      successDialog?.showModal();
    } else {
      throw new Error("Unified Checkout returned no payment result.");
    }
  } catch (error) {
    console.error("Unified Checkout payment failed:", error);

    if (error?.name === "UnifiedCheckoutError") {
      console.error("CyberSource error:", {
        reason: error.reason,
        message: error.message,
        code: error.code,
      });
    }

    throw error;
  } finally {
    if (checkout) {
      try {
        checkout.destroy();
      } catch (error) {
        console.warn("Could not destroy checkout:", error);
      }
    }

    if (client) {
      try {
        client.destroy();
      } catch (error) {
        console.warn("Could not destroy CyberSource client:", error);
      }
    }
  }
};

const getSessionContext = async (event) => {
  const button = event.currentTarget;
  const planKey = button.dataset.planKey;
  button.disabled = true;
  button.textContent = "Loading checkout...";
  statusMessage.textContent = "Preparing secure checkout...";
  checkoutSidebar?.classList.add("is-open");
  event.preventDefault();

  try {
    const response = await axios.post(`${BACKEND_URL}/checkout-session`, paymentPayload(planKey), { withCredentials: true });

    const captureContext = response.data;

    if (!captureContext) {
      throw new Error("The backend did not return a capture context.");
    }

    const decoded = decodeJwtPayload(captureContext);

    if (!decoded) {
      throw new Error("Could not decode capture context.");
    }

    const contextData = decoded?.ctx?.[0]?.data;

    if (!contextData) {
      throw new Error("Capture context does not contain ctx[0].data.");
    }

    const clientLibrary = contextData.clientLibrary;
    const integrity = contextData.clientLibraryIntegrity;

    if (!clientLibrary) {
      throw new Error("clientLibrary is missing from capture context.");
    }

    await loadCyberSourceSdk(clientLibrary, integrity);

    if (window.VAS && typeof window.VAS.UnifiedCheckout === "function") {
      await startWithVAS(captureContext, planKey);
      button.disabled = false;
      button.innerHTML = `Choose ${planKey} <span aria-hidden="true">&rarr;</span>`;
      statusMessage.textContent = "Payment complete. Your subscription is active.";
      return;
    }

    throw new Error("CyberSource SDK loaded, but neither VAS.UnifiedCheckout() nor Accept() is available.");
  } catch (error) {
    console.error(error);

    const backendError = error?.response?.data;

    if (backendError) {
      console.error("Backend error:", backendError);
      console.error("Backend error details:", JSON.stringify(backendError.details, null, 2));
    }

    statusMessage.textContent = backendError?.error || "Unable to initialize payment. Please try again.";
  }

  button.disabled = false;
  button.innerHTML = `Choose ${planKey} <span aria-hidden="true">&rarr;</span>`;
  checkoutSidebar?.classList.remove("is-open");
};

planButtons.forEach((button) => button.addEventListener("click", getSessionContext));
closeCheckoutButton?.addEventListener("click", () => checkoutSidebar?.classList.remove("is-open"));
closeSuccessDialogButton?.addEventListener("click", () => successDialog?.close());

const setPlanButtonsEnabled = (enabled) => {
  planButtons.forEach((button) => {
    button.disabled = !enabled;
  });
};

const showAccount = (user) => {
  currentAccount = user;
  accountForm.hidden = true;
  signedInState.hidden = false;
  signedInUsername.textContent = user.username;
  accountDescription.textContent = user.hasSubscription
    ? "Your account already has a subscription."
    : "Your next subscription will be connected to this account.";
  setPlanButtonsEnabled(!user.hasSubscription);
};

const showAccountForm = () => {
  currentAccount = null;
  accountForm.hidden = false;
  signedInState.hidden = true;
  accountSubmit.textContent = accountModeIsLogin ? "Log in" : "Create account";
  accountMode.textContent = accountModeIsLogin ? "Create an account instead" : "Log in instead";
  accountDescription.textContent = accountModeIsLogin ? "Log in to continue to your subscription." : "Create an account before choosing a plan.";
  setPlanButtonsEnabled(false);
};

accountMode?.addEventListener("click", () => {
  accountModeIsLogin = !accountModeIsLogin;
  accountMessage.textContent = "";
  showAccountForm();
});

accountForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  accountSubmit.disabled = true;
  accountMessage.textContent = "";
  try {
    const route = accountModeIsLogin ? "login" : "signup";
    const response = await axios.post(
      `${BACKEND_URL}/account/${route}`,
      {
        username: usernameInput.value,
        password: passwordInput.value,
      },
      { withCredentials: true },
    );
    passwordInput.value = "";
    showAccount(response.data.user);
  } catch (error) {
    accountMessage.textContent = error?.response?.data?.error || "Unable to update your account.";
  } finally {
    accountSubmit.disabled = false;
  }
});

logoutButton?.addEventListener("click", async () => {
  await axios.post(`${BACKEND_URL}/account/logout`, null, { withCredentials: true });
  showAccountForm();
});

const restoreAccount = async () => {
  try {
    const response = await axios.get(`${BACKEND_URL}/account/me`, { withCredentials: true });
    showAccount(response.data.user);
  } catch {
    showAccountForm();
  }
};

restoreAccount();
