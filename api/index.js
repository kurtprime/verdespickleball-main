const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 }   = require('uuid');
const { setupAdminRoutes } = require('../admin-api');
const { requireAuth } = require('../auth');

const app = express();
app.use(cors());
app.use(express.json());

// ── Init Supabase ─────────────────────────────────────────────────────────────
let supabase;
try {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error(`Missing env vars. SUPABASE_URL=${!!process.env.SUPABASE_URL} SUPABASE_SERVICE_KEY=${!!process.env.SUPABASE_SERVICE_KEY}`);
  }
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
} catch (initErr) {
  console.error('Supabase init failed:', initErr.message);
  // Return a clear JSON error for every route instead of crashing
  app.use((req, res) => res.status(503).json({ error: 'Database not configured', detail: initErr.message }));
  module.exports = app;
}

// Only register routes if supabase initialized successfully
if (supabase) {

// ── PUBLIC READ API (landing page) ─────────────────────────────────────────────
app.get('/api/courts', async (req, res) => {
  try {
    const { data, error } = await supabase.from('courts')
      .select('id, court_number, name, description, capacity, surface_type, status, image_url')
      .eq('status', 'active')
      .order('court_number');
    if (error) throw error;
    res.json(data || []);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch courts' }); }
});

app.get('/api/pricing', async (req, res) => {
  try {
    const date = req.query.date;
    let dayType = 'weekday';
    if (date) {
      const d = new Date(date + 'T00:00:00');
      if (!isNaN(d) && (d.getDay() === 0 || d.getDay() === 6)) dayType = 'weekend';
    }
    const { data, error } = await supabase.from('pricing').select('*').eq('is_active', true).order('duration_hours');
    if (error) throw error;
    const rows = data || [];
    const forDayType = rows.filter(r => r.day_type === dayType);
    const fallback   = rows.filter(r => r.day_type === 'weekday');
    const byDuration = {};
    fallback.forEach(r => { byDuration[r.duration_hours] = r; });
    forDayType.forEach(r => { byDuration[r.duration_hours] = r; });
    const rates = Object.values(byDuration).sort((a, b) => a.duration_hours - b.duration_hours);
    res.json({ date: date || null, dayType, rates });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch pricing' }); }
});

app.get('/api/payment-methods', async (req, res) => {
  try {
    const { data, error } = await supabase.from('payment_methods')
      .select('method_name, description, instructions, account_details, qr_code_url')
      .eq('is_active', true)
      .order('sort_order');
    if (error) throw error;
    res.json(data || []);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch payment methods' }); }
});

app.get('/api/website-settings', async (req, res) => {
  try {
    const { data } = await supabase.from('website_settings')
      .select('site_name, phone, email, address, operating_hours_start, operating_hours_end, site_description, about_text, terms_text, logo_url')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    res.json(data || { site_name: 'Velarde Courtside', operating_hours_start: '07:00', operating_hours_end: '19:00' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch website settings' }); }
});

// ── USER ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    if (!name || !email || !phone)
      return res.status(400).json({ error: 'Missing required fields' });
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existing) return res.json({ id: existing.id, message: 'User already exists' });
    const userId = uuidv4();
    const { error } = await supabase.from('users').insert({ id: userId, name, email, phone });
    if (error) throw error;
    res.status(201).json({ id: userId, name, email, phone });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create user' }); }
});

// ── AVAILABLE SLOTS ───────────────────────────────────────────────────────────
app.get('/api/available-slots/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const court = req.query.court ? parseInt(req.query.court) : null;

    let startHour = 7, endHour = 19;
    try {
      const { data: settings } = await supabase.from('website_settings')
        .select('operating_hours_start, operating_hours_end')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (settings?.operating_hours_start) startHour = parseInt(settings.operating_hours_start.substring(0, 2));
      if (settings?.operating_hours_end)   endHour   = parseInt(settings.operating_hours_end.substring(0, 2));
    } catch { /* keep defaults */ }
    if (endHour <= startHour) endHour += 24; // schedule crosses midnight

    const workingHours = [];
    for (let h = startHour; h < endHour; h++) workingHours.push(h);

    let query = supabase.from('bookings').select('start_time,end_time,court_number').eq('booking_date', date).neq('status','cancelled');
    if (court) query = query.eq('court_number', court);
    const { data: booked, error } = await query;
    if (error) throw error;

    const availableSlots = workingHours.filter(h => {
      const hh = h % 24;
      const t = `${String(hh).padStart(2,'0')}:00`;
      return !(booked||[]).some(s => s.start_time.substring(0,5) <= t && t < s.end_time.substring(0,5));
    }).map(h => `${String(h % 24).padStart(2,'0')}:00`);
    res.json({ date, availableSlots });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch available slots' }); }
});

// ── BOOKINGS ──────────────────────────────────────────────────────────────────
app.post('/api/bookings', async (req, res) => {
  try {
    const { userId, courtNumber, bookingDate, startTime, durationHours } = req.body;
    if (!userId||!courtNumber||!bookingDate||!startTime||!durationHours)
      return res.status(400).json({ error: 'Missing required fields' });

    const startHour = parseInt(startTime.split(':')[0]);
    const endTime   = `${String(startHour + parseInt(durationHours)).padStart(2,'0')}:00`;

    let dayType = 'weekday';
    const d = new Date(bookingDate + 'T00:00:00');
    if (!isNaN(d) && (d.getDay() === 0 || d.getDay() === 6)) dayType = 'weekend';

    const { data: pricingRows, error: pErr } = await supabase.from('pricing').select('*').eq('is_active', true);
    if (pErr) throw pErr;
    const rows = pricingRows || [];
    const rate = rows.find(r => r.duration_hours === parseInt(durationHours) && r.day_type === dayType)
              || rows.find(r => r.duration_hours === parseInt(durationHours) && r.day_type === 'weekday');
    if (!rate) return res.status(400).json({ error: 'No pricing configured for this duration' });
    const priceAmount = Number(rate.price_amount);

    const bookingId = uuidv4();
    const { error: bErr } = await supabase.from('bookings').insert({ id: bookingId, user_id: userId, court_number: courtNumber, booking_date: bookingDate, start_time: startTime, end_time: endTime, duration_hours: durationHours, price_amount: priceAmount, status: 'pending' });
    if (bErr) throw bErr;
    const paymentId = uuidv4();
    const { error: payErr } = await supabase.from('payments').insert({ id: paymentId, booking_id: bookingId, user_id: userId, amount: priceAmount, status: 'pending' });
    if (payErr) throw payErr;
    res.status(201).json({ bookingId, paymentId, courtNumber, bookingDate, startTime, endTime, durationHours, priceAmount, dayType, status: 'pending' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create booking' }); }
});

app.get('/api/bookings/user/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('bookings').select('*, payments(id,status)').eq('user_id', req.params.userId).order('booking_date', { ascending: false });
    if (error) throw error;
    res.json((data||[]).map(b => { const p=b.payments?.[0]||{}; const {payments:_,...r}=b; return {...r,payment_id:p.id,payment_status:p.status}; }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch bookings' }); }
});

// ── PAYMENTS ──────────────────────────────────────────────────────────────────
app.post('/api/payments/process', async (req, res) => {
  try {
    const { paymentId, bookingId, userId, amount, gcashReference } = req.body;
    if (!paymentId||!bookingId||!userId||!amount||!gcashReference)
      return res.status(400).json({ error: 'Missing required fields' });
    const { error: pErr } = await supabase.from('payments').update({ status:'completed', reference_number: gcashReference, paid_at: new Date().toISOString() }).eq('id', paymentId);
    if (pErr) throw pErr;
    const { error: bErr } = await supabase.from('bookings').update({ status:'confirmed' }).eq('id', bookingId);
    if (bErr) throw bErr;
    await supabase.from('time_tracking').insert({ id: uuidv4(), booking_id: bookingId });
    res.json({ success: true, message: 'Payment processed successfully', bookingId, paymentId, status: 'completed' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to process payment' }); }
});

app.post('/api/payments/counter', async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'Missing paymentId' });
    const { error } = await supabase.from('payments').update({ payment_method:'counter' }).eq('id', paymentId);
    if (error) throw error;
    res.json({ success: true, message: 'Payment method set to counter' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update payment method' }); }
});

app.get('/api/payments/:paymentId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments').select('*').eq('id', req.params.paymentId).single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Payment not found' });
    res.json(data);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch payment' }); }
});

// ── ADMIN CHECK-IN / CHECK-OUT ────────────────────────────────────────────────
app.post('/api/admin/checkin', requireAuth, async (req, res) => {
  try {
    const { bookingId, checkInTime } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });
    const t = checkInTime || new Date().toISOString();
    const { data: ex } = await supabase.from('time_tracking').select('id').eq('booking_id', bookingId).maybeSingle();
    if (ex) { await supabase.from('time_tracking').update({ check_in_time: t }).eq('booking_id', bookingId); }
    else     { await supabase.from('time_tracking').insert({ id: uuidv4(), booking_id: bookingId, check_in_time: t }); }
    res.json({ success: true, checkInTime: t });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to check in' }); }
});

app.post('/api/admin/checkout', requireAuth, async (req, res) => {
  try {
    const { bookingId, checkOutTime } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });
    const t = checkOutTime || new Date().toISOString();
    const { data: tr } = await supabase.from('time_tracking').select('check_in_time').eq('booking_id', bookingId).maybeSingle();
    const dur = tr?.check_in_time ? Math.round((new Date(t)-new Date(tr.check_in_time))/60000) : null;
    await supabase.from('time_tracking').update({ check_out_time: t, actual_duration_minutes: dur }).eq('booking_id', bookingId);
    res.json({ success: true, checkOutTime: t, actualDurationMinutes: dur, durationMinutes: dur });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to check out' }); }
});

app.post('/api/admin/reset-tracking', requireAuth, async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });
    await supabase.from('time_tracking').update({ check_in_time: null, check_out_time: null, actual_duration_minutes: null }).eq('booking_id', bookingId);
    res.json({ success: true, message: 'Tracking times reset' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to reset tracking' }); }
});

app.post('/api/admin/cancel-booking', requireAuth, async (req, res) => {
  try {
    const { bookingId, status } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });
    await supabase.from('bookings').update({ status: status||'cancelled' }).eq('id', bookingId);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to cancel booking' }); }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
setupAdminRoutes(app, supabase);

// close the if(supabase) block
module.exports = app;
}
