document.addEventListener("DOMContentLoaded", () => {
  const checkoutButton = document.getElementById("checkout-button");

  // Checkout button logic (simulated)
  checkoutButton.addEventListener("click", (e) => {
    e.preventDefault();
    paymentDialog.showModal();

    // Simulating loading state
    checkoutButton.innerHTML = `
            <svg class="spinner" viewBox="0 0 50 50" style="width: 20px; height: 20px; animation: spin 1s linear infinite;">
                <circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-dasharray="80" stroke-dashoffset="60"></circle>
            </svg>
            Processing...
        `;

    checkoutButton.style.opacity = "0.8";
    checkoutButton.style.pointerEvents = "none";

    // Add a quick spin animation for the spinner
    if (!document.getElementById("spinner-style")) {
      const style = document.createElement("style");
      style.id = "spinner-style";
      style.textContent = "@keyframes spin { 100% { transform: rotate(360deg); } }";
      document.head.appendChild(style);
    }
  });
});

const paymentDialog = document.getElementById("payment-dialog");
const subscribeButton = document.getElementById("subscribeButton");
const successDialog = document.getElementById("success-dialog");
const subscriptionId = document.getElementById("subscription-id");
const checkoutButton = document.getElementById("checkout-button");
const cancelDialog = document.getElementById("cancel-dialog");

cancelDialog.addEventListener("click", () => {
  paymentDialog.close();
  checkoutButton.innerHTML = "Subscribe";
  checkoutButton.style.opacity = "1";
  checkoutButton.style.pointerEvents = "auto";
});

subscribeButton.addEventListener("click", async (e) => {
  e.preventDefault();
  const formData = new FormData(document.getElementById("payment-form"));
  const payload = {
    buyerInformation: {
      merchantCustomerID: formData.get("merchantCustomerID"), //USER IDENTIFIER FROM YOUR WEBSITE
      email: formData.get("buyerEmail"), //USER EMAIL FROM YOUR WEBSITE
    },
    clientReferenceInformation: {
      code: "TC50171_3",
    },
    paymentInformation: {
      card: {
        number: formData.get("cardNumber"), //CARD NUMBER FROM YOUR WEBSITE
        expirationMonth: formData.get("expirationMonth"), //EXPIRATION MONTH FROM YOUR WEBSITE
        expirationYear: formData.get("expirationYear"), //EXPIRATION YEAR FROM YOUR WEBSITE
        cardType: formData.get("cardType"), //CARD TYPE FROM YOUR WEBSITE
      },
    },
    billTo: {
      firstName: formData.get("firstName"), //BILLING FIRST NAME
      lastName: formData.get("lastName"), //BILLING LAST NAME
      company: formData.get("company"), //BILLING COMPANY
      address1: formData.get("address1"), //BILLING ADDRESS
      locality: formData.get("locality"), //CITY
      administrativeArea: formData.get("administrativeArea"), //STATE/PROVINCE
      postalCode: formData.get("postalCode"), //POSTAL CODE
      country: formData.get("country"), //COUNTRY
      email: formData.get("billingEmail"), //BILLING EMAIL
      phoneNumber: formData.get("phoneNumber"), //BILLING PHONE NUMBER
    },
  };

  try {
    const response = await axios.post("https://recurring-billing-backend.vercel.app/subscribe-daily", payload, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    const subscription = response.data;
    const isSuccessful = subscription.status === "COMPLETED" && subscription.subscriptionInformation?.status === "ACTIVE";

    if (isSuccessful) {
      subscriptionId.textContent = subscription.id;
      paymentDialog.close();
      successDialog.showModal();
    }
  } catch (error) {
    console.error("Subscription request failed:", error.response?.data || error.message);
    alert("We could not create your subscription. Please check your details and try again.");
  } finally {
    checkoutButton.innerHTML = "Subscribe";
    checkoutButton.style.opacity = "1";
    checkoutButton.style.pointerEvents = "auto";
  }
});
