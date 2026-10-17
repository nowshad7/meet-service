import { createServer } from 'node:http';

const caption = {
  message_id: 'fake-final-1',
  participant_id: 'speaker-1',
  timestamp: Date.now(),
  language: 'bn',
  text: 'একটি পরীক্ষার ক্যাপশন।',
};

createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/final') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(caption));
}).listen(8080, '0.0.0.0');
