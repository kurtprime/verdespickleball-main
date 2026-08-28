const express = require('express');
const cors    = require('cors');
require('dotenv').config();
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { supabase }   = require('./database');
const { setupAdminRoutes } = require('./admin-api');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve static files in both dev and production
app.use(express.static(path.join(__dirname, 'public')));

// ── PUBLIC READ API (landing page) ───────────────────────────────────────────

app.get('/api/courts', async (req, res) => {
  try {
    const { data, error } = await supabase.from('courts')
      .select('id, court_number, name, description, capacity, surface_type, status, image_url')
      .eq('status', 'active')
      .order('court_number');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching courts:', err);
    res.status(500).json({ error: 'Failed to fetch courts' });
  }
});

app.get('/api/pricing', async (req, res) => {
  try {
    const date = req.query.date;
    let dayType = 'weekday';
    if (date) {
      const d = new Date(date + 'T00:00:00');
      if (!isNaN(d) && (d.getDay() === 0 || d.getDay() === 6)) dayType = 'weekend';
    }

    const { data, error } = await supabase.from('pricing')
      .select('*')
      .eq('is_active', true)
      .order('duration_hours');
    if (error) throw error;

    const rows = data || [];
    const forDayType = rows.filter(r => r.day_type === dayType);
    const fallback   = rows.filter(r => r.day_type === 'weekday');

    // Prefer the matching day type; fall back to weekday rows where missing
    const byDuration = {};
    fallback.forEach(r => { byDuration[r.duration_hours] = r; });
    forDayType.forEach(r => { byDuration[r.duration_hours] = r; });

    const rates = Object.values(byDuration).sort((a, b) => a.duration_hours - b.duration_hours);
    res.json({ date: date || null, dayType, rates });
  } catch (err) {
    console.error('Error fetching pricing:', err);
    res.status(500).json({ error: 'Failed to fetch pricing' });
  }
});

app.get('/api/payment-methods', async (req, res) => {
  try {
    const { data, error } = await supabase.from('payment_methods')
      .select('method_name, description, instructions, account_details, qr_code_url')
      .eq('is_active', true)
      .order('sort_order');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching payment methods:', err);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

app.get('/api/website-settings', async (req, res) => {
  try {
    const { data } = await supabase.from('website_settings')
      .select('site_name, phone, email, address, operating_hours_start, operating_hours_end, site_description, about_text, terms_text, logo_url')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    res.json(data || { site_name: 'Velarde Courtside', operating_hours_start: '07:00', operating_hours_end: '19:00' });
  } catch (err) {
    console.error('Error fetching website settings:', err);
    res.status(500).json({ error: 'Failed to fetch website settings' });
  }
});

// ── USER ROUTES ───────────────────────────────────────────────────────────────

app.post('/api/users', async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    if (!name || !email || !phone)
      return res.status(400).json({ error: 'Missing required fields' });

    const { data: existing } = await supabase
      .from('users').select('id').eq('email', email).maybeSingle();

    if (existing) return res.json({ id: existing.id, message: 'User already exists' });

    const userId = uuidv4();
    const { error } = await supabase.from('users').insert({ id: userId, name, email, phone });
    if (error) throw error;

    res.status(201).json({ id: userId, name, email, phone });
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── BOOKING ROUTES ────────────────────────────────────────────────────────────

app.get('/api/available-slots/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const court = req.query.court ? parseInt(req.query.court) : null;

    // Derive working hours from website_settings (fallback 07:00–19:00)
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

    let query = supabase.from('bookings')
      .select('start_time, end_time, court_number')
      .eq('booking_date', date)
      .neq('status', 'cancelled');
    if (court) query = query.eq('court_number', court);

    const { data: booked, error } = await query;
    if (error) throw error;

    const availableSlots = workingHours.filter(hour => {
      const hh = hour % 24;
      const timeStr = `${String(hh).padStart(2,'0')}:00`;
      return !(booked || []).some(slot => {
        const start = slot.start_time.substring(0, 5);
        const end   = slot.end_time.substring(0, 5);
        return start <= timeStr && timeStr < end;
      });
    }).map(hour => `${String(hour % 24).padStart(2,'0')}:00`);

    res.json({ date, availableSlots });
  } catch (err) {
    console.error('Error fetching slots:', err);
    res.status(500).json({ error: 'Failed to fetch available slots' });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { userId, courtNumber, bookingDate, startTime, durationHours } = req.body;
    if (!userId || !courtNumber || !bookingDate || !startTime || !durationHours)
      return res.status(400).json({ error: 'Missing required fields' });

    // Derive end time from start time + duration
    const startHour = parseInt(startTime.split(':')[0]);
    const endTime   = `${String(startHour + parseInt(durationHours)).padStart(2, '0')}:00`;

    // Derive day type from the booking date (weekend = Sat/Sun)
    let dayType = 'weekday';
    const d = new Date(bookingDate + 'T00:00:00');
    if (!isNaN(d) && (d.getDay() === 0 || d.getDay() === 6)) dayType = 'weekend';

    // Look up the server-side rate (duration + day type, fallback weekday)
    const { data: pricingRows, error: pErr } = await supabase.from('pricing')
      .select('*').eq('is_active', true);
    if (pErr) throw pErr;

    const rows = pricingRows || [];
    const rate = rows.find(r => r.duration_hours === parseInt(durationHours) && r.day_type === dayType)
              || rows.find(r => r.duration_hours === parseInt(durationHours) && r.day_type === 'weekday');

    if (!rate) return res.status(400).json({ error: 'No pricing configured for this duration' });
    const priceAmount = Number(rate.price_amount);

    const bookingId = uuidv4();
    const { error: bErr } = await supabase.from('bookings').insert({
      id: bookingId, user_id: userId, court_number: courtNumber,
      booking_date: bookingDate, start_time: startTime, end_time: endTime,
      duration_hours: durationHours, price_amount: priceAmount, status: 'pending'
    });
    if (bErr) throw bErr;

    const paymentId = uuidv4();
    const { error: payErr } = await supabase.from('payments').insert({
      id: paymentId, booking_id: bookingId, user_id: userId,
      amount: priceAmount, status: 'pending'
    });
    if (payErr) throw payErr;

    res.status(201).json({ bookingId, paymentId, courtNumber, bookingDate, startTime, endTime, durationHours, priceAmount, dayType, status: 'pending' });
  } catch (err) {
    console.error('Error creating booking:', err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.get('/api/bookings/user/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*, payments(id, status)')
      .eq('user_id', req.params.userId)
      .order('booking_date', { ascending: false });
    if (error) throw error;

    const result = (data || []).map(b => {
      const pay = b.payments?.[0] || {};
      const { payments: _, ...rest } = b;
      return { ...rest, payment_id: pay.id, payment_status: pay.status };
    });
    res.json(result);
  } catch (err) {
    console.error('Error fetching bookings:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ── PAYMENT ROUTES ────────────────────────────────────────────────────────────

app.post('/api/payments/process', async (req, res) => {
  try {
    const { paymentId, bookingId, userId, amount, gcashReference } = req.body;
    if (!paymentId || !bookingId || !userId || !amount || !gcashReference)
      return res.status(400).json({ error: 'Missing required fields' });

    const { error: pErr } = await supabase.from('payments')
      .update({ status: 'completed', reference_number: gcashReference, paid_at: new Date().toISOString() })
      .eq('id', paymentId);
    if (pErr) throw pErr;

    const { error: bErr } = await supabase.from('bookings')
      .update({ status: 'confirmed' }).eq('id', bookingId);
    if (bErr) throw bErr;

    const { error: tErr } = await supabase.from('time_tracking')
      .insert({ id: uuidv4(), booking_id: bookingId });
    if (tErr) throw tErr;

    res.json({ success: true, message: 'Payment processed successfully', bookingId, paymentId, status: 'completed' });
  } catch (err) {
    console.error('Error processing payment:', err);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

app.post('/api/payments/counter', async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'Missing paymentId' });

    const { error } = await supabase.from('payments')
      .update({ payment_method: 'counter' }).eq('id', paymentId);
    if (error) throw error;

    res.json({ success: true, message: 'Payment method set to counter' });
  } catch (err) {
    console.error('Error updating payment:', err);
    res.status(500).json({ error: 'Failed to update payment method' });
  }
});

app.get('/api/payments/:paymentId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments')
      .select('*').eq('id', req.params.paymentId).single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Payment not found' });
    res.json(data);
  } catch (err) {
    console.error('Error fetching payment:', err);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// ── ADMIN CHECK-IN / CHECK-OUT ────────────────────────────────────────────────

app.post('/api/admin/checkin', async (req, res) => {
  try {
    const { bookingId, checkInTime } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

    const timeToSet = checkInTime || new Date().toISOString();
    const { data: existing } = await supabase.from('time_tracking')
      .select('id').eq('booking_id', bookingId).maybeSingle();

    if (existing) {
      const { error } = await supabase.from('time_tracking')
        .update({ check_in_time: timeToSet }).eq('booking_id', bookingId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('time_tracking')
        .insert({ id: uuidv4(), booking_id: bookingId, check_in_time: timeToSet });
      if (error) throw error;
    }

    res.json({ success: true, message: 'Check-in recorded', checkInTime: timeToSet });
  } catch (err) {
    console.error('Error checking in:', err);
    res.status(500).json({ error: 'Failed to check in' });
  }
});

app.post('/api/admin/checkout', async (req, res) => {
  try {
    const { bookingId, checkOutTime } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

    const timeToSet = checkOutTime || new Date().toISOString();
    const { data: tracking } = await supabase.from('time_tracking')
      .select('check_in_time').eq('booking_id', bookingId).maybeSingle();

    let actualDurationMinutes = null;
    if (tracking?.check_in_time) {
      actualDurationMinutes = Math.round((new Date(timeToSet) - new Date(tracking.check_in_time)) / 60000);
    }

    const { error } = await supabase.from('time_tracking')
      .update({ check_out_time: timeToSet, actual_duration_minutes: actualDurationMinutes })
      .eq('booking_id', bookingId);
    if (error) throw error;

    res.json({ success: true, message: 'Check-out recorded', checkOutTime: timeToSet, actualDurationMinutes, durationMinutes: actualDurationMinutes });
  } catch (err) {
    console.error('Error checking out:', err);
    res.status(500).json({ error: 'Failed to check out' });
  }
});

app.post('/api/admin/reset-tracking', async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

    const { error } = await supabase.from('time_tracking')
      .update({ check_in_time: null, check_out_time: null, actual_duration_minutes: null })
      .eq('booking_id', bookingId);
    if (error) throw error;

    res.json({ success: true, message: 'Tracking times reset' });
  } catch (err) {
    console.error('Error resetting tracking:', err);
    res.status(500).json({ error: 'Failed to reset tracking' });
  }
});

app.post('/api/admin/cancel-booking', async (req, res) => {
  try {
    const { bookingId, status } = req.body;
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

    const { error } = await supabase.from('bookings')
      .update({ status: status || 'cancelled' }).eq('id', bookingId);
    if (error) throw error;

    res.json({ success: true, message: 'Booking status updated' });
  } catch (err) {
    console.error('Error cancelling booking:', err);
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
setupAdminRoutes(app, supabase);

// ── START (local dev only) ────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`✅ Velarde Courtside server running on http://localhost:${PORT}`);
  });
}

// SPA fallback: specific pages first, then index.html for everything else
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;
