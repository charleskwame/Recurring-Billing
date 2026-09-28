const BACKEND_URL = "https://recurring-billing-backend.vercel.app";

// CyberSource only indexes a completed payment for follow-on subscription creation a few seconds after it happens, so activation is retried before giving up.

const ACTIVATION_MAX_ATTEMPTS = 6;
const ACTIVATION_RETRY_DELAY_MS = 3000;

const proceedToPaymentButton = document.getElementById("proceedToPayment");
const checkoutContainer = document.getElementById("unified-checkout-container");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The backend answers 409 + retryable:true (or an upstream gateway error) while the payment is

// still being indexed, and that is the only case where retrying the activation makes sense.

const isActivationRetryable = (error) => {
  if (error?.response?.data?.retryable) {
    return true;
  }

  const status = error?.response?.status;

  if (!status) {
    return true;
  }

  return status === 502 || status === 503 || status === 504;
};

// const activateRecurringBilling = async (result) => {
//   for (let attempt = 1; attempt <= ACTIVATION_MAX_ATTEMPTS; attempt += 1) {
//     try {
//       return await axios.post(`${BACKEND_URL}/activate-recurring-billing`, {
//         result,
//       });
//     } catch (error) {
//       const isLastAttempt = attempt === ACTIVATION_MAX_ATTEMPTS;

//       if (!isActivationRetryable(error) || isLastAttempt) {
//         throw error;
//       }

//       console.warn(
//         `Recurring billing is not ready yet (attempt ${attempt}/${ACTIVATION_MAX_ATTEMPTS}). Retrying in ${ACTIVATION_RETRY_DELAY_MS}ms.`,
//         error?.response?.data,
//       );
//       proceedToPaymentButton.innerHTML = `Finalizing Subscription, Please Wait... (${attempt}/${ACTIVATION_MAX_ATTEMPTS})`;
//       await sleep(ACTIVATION_RETRY_DELAY_MS);
//     }
//   }

//   throw new Error("Recurring billing activation failed.");
// };

const activateRecurringBilling = async (result) => {
  try {
    return await axios.post(`${BACKEND_URL}/activate-recurring-billing`, {
      result,
    });
  } catch (error) {
    console.log(error);
  }
  // for (let attempt = 1; attempt <= ACTIVATION_MAX_ATTEMPTS; attempt += 1) {
  // }

  throw new Error("Recurring billing activation failed.");
};

const paymentPayload = {
  targetOrigins: ["https://recurring-billing-frontend.vercel.app"],
  clientVersion: "1.0",
  country: "US",
  locale: "en_US",
  data: {
    orderInformation: {
      amountDetails: {
        totalAmount: "20.00",
        currency: "USD",
      },
    },
  },
};

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

const startWithVAS = async (captureContext) => {
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

    console.log(result);

    if (result) {
      const response = await activateRecurringBilling(result);

      console.log("Payment result response:", response);
      console.log("Subscription result response:", response.data);
      alert(`Subscription response:\n${JSON.stringify(response.data, null, 2)}`);
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
  let isProcessing = true;
  proceedToPaymentButton.innerHTML = `${isProcessing ? "Loading Checkout, Please Wait..." : "Proceed to Payment"}`;
  proceedToPaymentButton.setAttribute("disabled", isProcessing);
  checkoutContainer?.classList.add("is-initializing");
  event.preventDefault();

  try {
    const response = await axios.post(`${BACKEND_URL}/checkout-session`, paymentPayload);

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
      await startWithVAS(captureContext);
      isProcessing = false;
      proceedToPaymentButton.innerHTML = `${isProcessing ? "Loading Checkout, Please Wait..." : "Proceed to Payment"}`;
      proceedToPaymentButton.removeAttribute("disabled");
      checkoutContainer?.classList.remove("is-initializing");
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

    alert("Unable to initialize payment. Please check the browser console for details.");
  }

  isProcessing = false;
  proceedToPaymentButton.innerHTML = `${isProcessing ? "Loading Checkout, Please Wait..." : "Proceed to Payment"}`;
  proceedToPaymentButton.removeAttribute("disabled");
  checkoutContainer?.classList.remove("is-initializing");
};

if (!proceedToPaymentButton) {
  console.error("Could not find #proceedToPayment button.");
} else {
  proceedToPaymentButton.addEventListener("click", getSessionContext);
}
