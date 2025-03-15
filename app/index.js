const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let streams = {};

app.post('/start', (req, res) => {
  const { streamKey } = req.body;
  streams[streamKey] = { status: 'live', startedAt: Date.now() };
  res.json({ message: 'Stream started', streamKey });
});

app.post('/stop', (req, res) => {
  const { streamKey } = req.body;
  streams[streamKey] = { status: 'stopped', stoppedAt: Date.now() };
  res.json({ message: 'Stream stopped', streamKey });
});

app.get('/status/:streamKey', (req, res) => {
  const stream = streams[req.params.streamKey];
  if (!stream) return res.status(404).json({ message: 'Stream not found' });
  res.json(stream);
});

app.listen(PORT, () => {
    console.log(`StreamFlow API running on port ${PORT}`);
});