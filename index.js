require("dotenv").config();

const http = require("http");
const twilio = require("twilio");

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

// Reads and parses a JSON body from an incoming POST request.
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
        "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        });
        res.end();
        return;
    }

    if (req.url === "/") {
        return sendJson(res, 200, { status: "Backend is running." });
    }

    // ---- Contact owner ----
    if (req.url === "/contact-owner" && req.method === "POST") {
        try {
            console.log("About to contact Twilio for a call...");

            const call = await client.calls.create({
                to: process.env.OWNER_PHONE_NUMBER,
                from: process.env.TWILIO_PHONE_NUMBER,
                twiml: "<Response><Say>Someone needs you at your car.</Say></Response>"
            });

            console.log("Call started:", call.sid);
            return sendJson(res, 200, { success: true, message: "Owner contact request received!" });

        } catch (error) {
            console.error("Twilio error:", error.message);
            return sendJson(res, 500, { success: false, message: "Could not call the owner." });
        }
    }

    // ---- Send OTP ----
    // POST /auth/send-otp   body: { "phoneNumber": "+91XXXXXXXXXX" }
    if (req.url === "/auth/send-otp" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const { phoneNumber } = body;

            if (!phoneNumber || !phoneNumber.startsWith("+")) {
                return sendJson(res, 400, {
                    success: false,
                    error: "phoneNumber is required and must include country code, e.g. +91XXXXXXXXXX"
                });
            }

            console.log("Sending OTP to", phoneNumber);

            const verification = await client.verify.v2
                .services(verifyServiceSid)
                .verifications.create({ to: phoneNumber, channel: "sms" });

            console.log("OTP sent, status:", verification.status);
            return sendJson(res, 200, { success: true, status: verification.status });

        } catch (error) {
            console.error("send-otp error:", error.message);
            return sendJson(res, 500, { success: false, error: error.message });
        }
    }

    // ---- Verify OTP ----
    // POST /auth/verify-otp   body: { "phoneNumber": "+91XXXXXXXXXX", "code": "123456" }
    if (req.url === "/auth/verify-otp" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const { phoneNumber, code } = body;

            if (!phoneNumber || !code) {
                return sendJson(res, 400, {
                    success: false,
                    error: "phoneNumber and code are required."
                });
            }

            console.log("Verifying OTP for", phoneNumber);

            const check = await client.verify.v2
                .services(verifyServiceSid)
                .verificationChecks.create({ to: phoneNumber, code });

            console.log("Verify status:", check.status);
            return sendJson(res, 200, {
                success: true,
                verified: check.status === "approved"
            });

        } catch (error) {
            console.error("verify-otp error:", error.message);
            return sendJson(res, 500, { success: false, error: error.message });
        }
    }

    return sendJson(res, 404, { success: false, error: "Not found" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});