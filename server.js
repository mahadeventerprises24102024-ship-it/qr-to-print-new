
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve website files
app.use(express.static(path.join(__dirname)));

// Check whether backend is running
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "QR-To-Print backend is running"
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`QR-To-Print server running on port ${PORT}`);
});
