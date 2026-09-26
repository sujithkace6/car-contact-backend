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

const NEARBY_RADIUS_METERS = 10;
const OUT_OF_RANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

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

function publicVehicle(vehicle) {
  const { pairingCode, ...rest } = vehicle;
  return rest;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

function checkWithinRange(vehicle, latitude, longitude) {
  if (!vehicle.parkedLocation || typeof latitude !== "number" || typeof longitude !== "number") {
    return true; // no known parked location — don't block on distance we can't verify
  }
  return distanceMeters(vehicle.parkedLocation, { latitude, longitude }) <= NEARBY_RADIUS_METERS;
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

  if (req.url === "/identify-vehicle" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { pairingCode, latitude, longitude } = body;

      if (!pairingCode) {
        return sendJson(res, 400, { success: false, error: "pairingCode is required." });
      }

      const vehicle = vehicles.find((v) => v.pairingCode === pairingCode);
      if (!vehicle) {
        return sendJson(res, 404, { success: false, error: "This tag isn't registered to any vehicle." });
      }

      const withinRange = checkWithinRange(vehicle, latitude, longitude);

      let callAvailable = true;
      let callRetryAt = null;
      if (!withinRange && vehicle.lastOutOfRangeCallAt) {
        const elapsed = Date.now() - new Date(vehicle.lastOutOfRangeCallAt).getTime();
        if (elapsed < OUT_OF_RANGE_COOLDOWN_MS) {
          callAvailable = false;
          callRetryAt = new Date(new Date(vehicle.lastOutOfRangeCallAt).getTime() + OUT_OF_RANGE_COOLDOWN_MS).toISOString();
        }
      }

      return sendJson(res, 200, {
        success: true,
        vehicleId: vehicle.id,
        vehicleName: vehicle.name,
        withinRange,
        callAvailable,
        callRetryAt,
      });
    } catch (error) {
      console.error("identify-vehicle error:", error.message);
      return sendJson(res, 500, { success: false, error: "Could not identify vehicle." });
    }
  }

  const contactMatch = req.url.match(/^\/vehicles\/([^/]+)\/contact$/);
  if (contactMatch && req.method === "POST") {
    try {
      const vehicleId = contactMatch[1];
      const body = await readJsonBody(req);
      const { action, userPhoneNumber, latitude, longitude } = body;

      const vehicle = vehicles.find((v) => v.id === vehicleId);
      if (!vehicle) {
        return sendJson(res, 404, { success: false, error: "Vehicle not found." });
      }

      if (action !== "call" && action !== "emergency") {
        return sendJson(res, 400, { success: false, error: "action must be 'call' or 'emergency'." });
      }

      const withinRange = checkWithinRange(vehicle, latitude, longitude);

      if (action === "emergency") {
        if (!withinRange) {
          return sendJson(res, 403, {
            success: false,
            error: "You must be within 10 meters of the vehicle to send an emergency alert.",
          });
        }

        // Emergency bypasses the notifications toggle since it's urgent.
        await client.messages.create({
          to: vehicle.ownerPhoneNumber,
          from: process.env.TWILIO_PHONE_NUMBER,
          body: `EMERGENCY regarding your vehicle ${vehicle.name} (${vehicle.vehicleNumber}). Please call this number immediately: ${userPhoneNumber || "not provided"}`,
        });
        return sendJson(res, 200, { success: true, message: "Emergency SMS sent to the owner." });
      }

      // action === "call"
      if (!withinRange) {
        if (vehicle.lastOutOfRangeCallAt) {
          const elapsed = Date.now() - new Date(vehicle.lastOutOfRangeCallAt).getTime();
          if (elapsed < OUT_OF_RANGE_COOLDOWN_MS) {
            return sendJson(res, 403, {
              success: false,
              error: "Only one call per day is allowed from this distance for this vehicle. Please try again later.",
            });
          }
        }
      }

      if (!vehicle.notificationsEnabled) {
        return sendJson(res, 200, {
          success: false,
          message: "The owner has turned off notifications for this vehicle.",
        });
      }

      if (!withinRange) {
        vehicle.lastOutOfRangeCallAt = new Date().toISOString();
      }

      await client.calls.create({
        to: vehicle.ownerPhoneNumber,
        from: process.env.TWILIO_PHONE_NUMBER,
        twiml: "<Response><Say>Someone needs you at your car.</Say></Response>",
      });
      return sendJson(res, 200, { success: true, message: "Owner is being called now." });
    } catch (error) {
      console.error("contact error:", error.message);
      return sendJson(res, 500, { success: false, error: "Could not complete this action." });
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
      const { name, vehicleNumber, pairingCode, ownerPhoneNumber } = body;

      if (!name || !vehicleNumber || !pairingCode || !ownerPhoneNumber) {
        return sendJson(res, 400, { success: false, error: "name, vehicleNumber, pairingCode, and ownerPhoneNumber are required." });
      }

      const validCodes = VALID_VEHICLE_PAIRINGS[vehicleNumber.toUpperCase()] || [];
      if (!validCodes.includes(pairingCode)) {
        return sendJson(res, 403, { success: false, error: "Pairing code does not match this vehicle number." });
      }

      const vehicle = {
        id: String(vehicles.length + 1),
        name,
        vehicleNumber: vehicleNumber.toUpperCase(),
        ownerPhoneNumber,
        pairingCode,
        parkedAt: null,
        parkedLocation: null,
        notificationsEnabled: false,
        lastOutOfRangeCallAt: null,
      };
      vehicles.push(vehicle);

      return sendJson(res, 200, { success: true, vehicle: publicVehicle(vehicle) });
    } catch (error) {
      console.error("save vehicle error:", error.message);
      return sendJson(res, 500, { success: false, error: "Could not save vehicle." });
    }
  }

  if (req.url.startsWith("/vehicles") && req.method === "GET") {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const phoneNumber = urlObj.searchParams.get("phoneNumber");

    const filtered = phoneNumber
      ? vehicles.filter((v) => v.ownerPhoneNumber === phoneNumber)
      : vehicles;

    return sendJson(res, 200, { success: true, vehicles: filtered.map(publicVehicle) });
  }

  const parkMatch = req.url.match(/^\/vehicles\/([^/]+)\/park$/);
  if (parkMatch && req.method === "POST") {
    try {
      const vehicleId = parkMatch[1];
      const body = await readJsonBody(req);
      const { pairingCode, latitude, longitude } = body;

      const vehicle = vehicles.find((v) => v.id === vehicleId);
      if (!vehicle) {
        return sendJson(res, 404, { success: false, error: "Vehicle not found." });
      }

      if (!pairingCode || pairingCode !== vehicle.pairingCode) {
        return sendJson(res, 403, { success: false, error: "This tag doesn't match this vehicle." });
      }

      vehicle.parkedAt = new Date().toISOString();
      vehicle.parkedLocation = { latitude, longitude };
      vehicle.notificationsEnabled = true; // default ON whenever a park scan succeeds
      vehicle.lastOutOfRangeCallAt = null; // fresh session at the new spot

      const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
      try {
        await client.messages.create({
          to: vehicle.ownerPhoneNumber,
          from: process.env.TWILIO_PHONE_NUMBER,
          body: `Your vehicle ${vehicle.name} (${vehicle.vehicleNumber}) was parked here: ${mapsLink}`,
        });
      } catch (smsError) {
        console.error("park SMS error:", smsError.message);
      }

      return sendJson(res, 200, {
        success: true,
        parkedAt: vehicle.parkedAt,
        notificationsEnabled: vehicle.notificationsEnabled,
      });
    } catch (error) {
      console.error("park error:", error.message);
      return sendJson(res, 500, { success: false, error: "Could not mark parking." });
    }
  }

  const endParkMatch = req.url.match(/^\/vehicles\/([^/]+)\/end-park$/);
  if (endParkMatch && req.method === "POST") {
    try {
      const vehicleId = endParkMatch[1];
      const vehicle = vehicles.find((v) => v.id === vehicleId);
      if (!vehicle) {
        return sendJson(res, 404, { success: false, error: "Vehicle not found." });
      }

      vehicle.parkedAt = null;
      vehicle.parkedLocation = null;
      vehicle.notificationsEnabled = false;
      vehicle.lastOutOfRangeCallAt = null;

      return sendJson(res, 200, { success: true });
    } catch (error) {
      console.error("end-park error:", error.message);
      return sendJson(res, 500, { success: false, error: "Could not end parking." });
    }
  }

  const notificationsMatch = req.url.match(/^\/vehicles\/([^/]+)\/notifications$/);
  if (notificationsMatch && req.method === "POST") {
    try {
      const vehicleId = notificationsMatch[1];
      const body = await readJsonBody(req);
      const { enabled } = body;

      const vehicle = vehicles.find((v) => v.id === vehicleId);
      if (!vehicle) {
        return sendJson(res, 404, { success: false, error: "Vehicle not found." });
      }

      vehicle.notificationsEnabled = !!enabled;

      return sendJson(res, 200, { success: true, notificationsEnabled: vehicle.notificationsEnabled });
    } catch (error) {
      console.error("notifications error:", error.message);
      return sendJson(res, 500, { success: false, error: "Could not update notifications." });
    }
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