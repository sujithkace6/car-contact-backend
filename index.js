require("dotenv").config();

const http = require("http");
const twilio = require("twilio");

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

const VALID_VEHICLE_PAIRINGS = {
  MH01BF9379: ["12345678", "87654321"],
  MH01BF9380: ["11112222"],
  MH01BF9381: ["22223333"],
};

const vehicles = [];
const familyMembers = [];

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.url === "/") {
    return sendJson(res, 200, { status: "Backend is running." });
  }

  if (req.url === "/contact-owner" && req.method === "POST") {
    try {
      const call = await client.calls.create({
        to: process.env.OWNER_PHONE_NUMBER,
        from: process.env.TWILIO_PHONE_NUMBER,
        twiml: "<Response><Say>Someone needs you at your car.</Say></Response>",
      });
      return sendJson(res, 200, { success: true, message: "Owner contact request received!" });
    } catch (error) {
      console.error("Twilio error:", error.message);
      return sendJson(res, 500, { success: false, message: "Could not call the owner." });
    }
  }

  if (req.url === "/contact-relative" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { relativePhoneNumber, userPhoneNumber, mapsLink } = body;

      if (!relativePhoneNumber || !mapsLink) {
        return sendJson(res, 400, { success: false, error: "relativePhoneNumber and mapsLink are required." });
      }

      await client.calls.create({
        to: relativePhoneNumber,
        from: process.env.TWILIO_PHONE_NUMBER,
        twiml: "<Response><Say>Someone needs you. Check your messages for their location.</Say></Response>",
      });

      await client.messages.create({
        to: relativePhoneNumber,
        from: process.env.TWILIO_PHONE_NUMBER,
        body: `Location: ${mapsLink}\nContact number: ${userPhoneNumber || "not provided"}`,
      });

      return sendJson(res, 200, { success: true });
    } catch (error) {
      console.error("contact-relative error:", error.message);
      return sendJson(res, 500, { success: false, message: "Could not reach the relative." });
    }
  }

  if (req.url === "/auth/send-otp" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { phoneNumber } = body;

      if (!phoneNumber || !phoneNumber.startsWith("+")) {
        return sendJson(res, 400, { success: false, error: "phoneNumber is required and must include country code." });
      }

      const verification = await client.verify.v2.services(verifyServiceSid).verifications.create({ to: phoneNumber, channel: "sms" });
      return sendJson(res, 200, { success: true, status: verification.status });
    } catch (error) {
      console.error("send-otp error:", error.message);
      return sendJson(res, 500, { success: false, error: error.message });
    }
  }

  if (req.url === "/auth/verify-otp" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { phoneNumber, code } = body;

      if (!phoneNumber || !code) {
        return sendJson(res, 400, { success: false, error: "phoneNumber and code are required." });
      }

      const check = await client.verify.v2.services(verifyServiceSid).verificationChecks.create({ to: phoneNumber, code });
      return sendJson(res, 200, { success: true, verified: check.status === "approved" });
    } catch (error) {
      console.error("verify-otp error:", error.message);
      return sendJson(res, 500, { success: false, error: error.message });
    }
  }

  if (req.url === "/verify-vehicle" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { vehicleNumber, pairingCode } = body;

      if (!vehicleNumber || !pairingCode) {
        return sendJson(res, 400, { success: false, error: "vehicleNumber and pairingCode are required." });
      }

      const validCodes = VALID_VEHICLE_PAIRINGS[vehicleNumber.toUpperCase()] || [];
      const verified = validCodes.includes(pairingCode);

      return sendJson(res, 200, { success: true, verified });
    } catch (error) {
      console.error("verify-vehicle error:", error.message);
      return sendJson(res, 500, { success: false, error: "Verification failed." });
    }
  }

  if (req.url === "/vehicles" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { name, vehicleNumber, pairingCode } = body;

      if (!name || !vehicleNumber || !pairingCode) {
        return sendJson(res, 400, { success: false, error: "name, vehicleNumber, and pairingCode are required." });
      }

      const validCodes = VALID_VEHICLE_PAIRINGS[vehicleNumber.toUpperCase()] || [];
      if (!validCodes.includes(pairingCode)) {
        return sendJson(res, 403, { success: false, error: "Pairing code does not match this vehicle number." });
      }

      const vehicle = { id: String(vehicles.length + 1), name, vehicleNumber: vehicleNumber.toUpperCase() };
      vehicles.push(vehicle);

      return sendJson(res, 200, { success: true, vehicle });
    } catch (error) {
      console.error("save vehicle error:", error.message);
      return sendJson(res, 500, { success: false, error: "Could not save vehicle." });
    }
  }

  if (req.url === "/vehicles" && req.method === "GET") {
    return sendJson(res, 200, { success: true, vehicles });
  }

  if (req.url === "/family-members" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { name, relationship, phoneNumber, pairingCode } = body;

      if (!name || !relationship || !phoneNumber || !pairingCode) {
        return sendJson(res, 400, { success: false, error: "name, relationship, phoneNumber, and pairingCode are required." });
      }

      const familyMember = { id: String(familyMembers.length + 1), name, relationship, phoneNumber };
      familyMembers.push(familyMember);

      return sendJson(res, 200, { success: true, familyMember });
    } catch (error) {
      console.error("save family member error:", error.message);
      return sendJson(res, 500, { success: false, error: "Could not save family member." });
    }
  }

  if (req.url === "/family-members" && req.method === "GET") {
    return sendJson(res, 200, { success: true, familyMembers });
  }

  return sendJson(res, 404, { success: false, error: "Not found" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});