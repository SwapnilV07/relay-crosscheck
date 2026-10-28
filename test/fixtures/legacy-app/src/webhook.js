// Express handler for Relay webhook events
app.post("/relay-hook", (req, res) => {
  if (req.body.event === "request.status.updated") updateOrder(req.body.data);
  res.sendStatus(200);
});
