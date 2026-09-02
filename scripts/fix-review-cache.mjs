import fs from 'node:fs';

const path = 'mobile-beta-test-preload.js';
let s = fs.readFileSync(path, 'utf8');

const oldInProgress = `  app.get('/api/paciente/atendimento-em-andamento', authPaciente, async (req, res, next) => {
    try {
      const paciente = await pacienteBeta(req.pacienteId);`;
const newInProgress = `  app.get('/api/paciente/atendimento-em-andamento', authPaciente, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      const paciente = await pacienteBeta(req.pacienteId);`;
if (!s.includes(oldInProgress)) throw new Error('review in-progress route snippet not found');
s = s.replace(oldInProgress, newInProgress);

const oldPix = `  app.get('/api/pagbank/order/:orderId', async (req, res, next) => {
    try {
      const orderId = String(req.params.orderId || '');`;
const newPix = `  app.get('/api/pagbank/order/:orderId', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      const orderId = String(req.params.orderId || '');`;
if (!s.includes(oldPix)) throw new Error('review pix route snippet not found');
s = s.replace(oldPix, newPix);

fs.writeFileSync(path, s);
console.log('Backend review cache patch applied.');
