const API_BASE = window.location.origin + '/api';

let currentUser    = null;
let currentBooking = null;
let paymentMethod  = 'gcash';
let currentStep    = 1;

let courts       = [];
let pricingRates = [];   // rates for the currently selected date
let settings     = null;

// ─── INIT ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setMinDate();
  loadSiteData();
  loadPaymentMethods();
  setupEventListeners();
});

function setupEventListeners() {

  // Court grid click
  document.getElementById('courtGrid').addEventListener('click', e => {
    const card = e.target.closest('.court-card');
    if (card) selectCourt(card);
  });

  // Wizard back buttons
  document.getElementById('changeCourtBtn').addEventListener('click',   () => goToStep(1));
  document.getElementById('backToCourtsBtn').addEventListener('click',  () => goToStep(1));
  document.getElementById('backToDetailsBtn').addEventListener('click', () => goToStep(2));

  // Step indicators
  document.querySelectorAll('.step-ind').forEach(ind => {
    ind.addEventListener('click', () => {
      const t = parseInt(ind.dataset.step);
      if (t < currentStep) goToStep(t);
    });
  });

  // *** "Continue to Payment" — direct click handler ***
  document.getElementById('continueToPaymentBtn').addEventListener('click', handleContinueClick);

  // Price update
  document.getElementById('duration').addEventListener('change', updatePrice);

  // Time slots + pricing reload on date change
  document.getElementById('date').addEventListener('change', () => {
    loadPricing();
    loadAvailableSlots();
  });

  // Payment method toggle
  document.querySelectorAll('input[name="paymentMethod"]').forEach(radio => {
    radio.addEventListener('change', () => {
      paymentMethod = radio.value;
      document.getElementById('gcashDetails').classList.toggle('expanded',   paymentMethod === 'gcash');
      document.getElementById('counterDetails').classList.toggle('expanded', paymentMethod === 'counter');
      // highlight selected option
      document.getElementById('payOptionGcash').classList.toggle('pay-option-selected',   paymentMethod === 'gcash');
      document.getElementById('payOptionCounter').classList.toggle('pay-option-selected', paymentMethod === 'counter');
    });
  });

  // Also allow clicking the whole div to select the radio
  document.getElementById('payOptionGcash').addEventListener('click', e => {
    if (e.target.tagName !== 'INPUT') {
      document.getElementById('radioGcash').checked = true;
      document.getElementById('radioGcash').dispatchEvent(new Event('change'));
    }
  });
  document.getElementById('payOptionCounter').addEventListener('click', e => {
    if (e.target.tagName !== 'INPUT') {
      document.getElementById('radioCounter').checked = true;
      document.getElementById('radioCounter').dispatchEvent(new Event('change'));
    }
  });

  document.getElementById('gcashDetails').classList.add('expanded');
  document.getElementById('payOptionGcash').classList.add('pay-option-selected');

  // Confirm + receipt buttons
  document.getElementById('confirmBookingBtn').addEventListener('click',  confirmBooking);
  document.getElementById('downloadReceiptBtn').addEventListener('click', downloadReceipt);
  document.getElementById('bookAnotherBtn').addEventListener('click',     resetFlow);
}

// ─── WIZARD ──────────────────────────────────────────────────────────────────
function goToStep(step) {
  currentStep = step;
  ['stepCourt','stepDetails','stepPayment'].forEach((id, i) => {
    document.getElementById(id).classList.toggle('active', i + 1 === step);
  });
  document.querySelectorAll('.step-ind').forEach(ind => {
    const n = parseInt(ind.dataset.step);
    ind.classList.toggle('active', n === step);
    ind.classList.toggle('done',   n <  step);
  });
  document.getElementById('booking').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectCourt(card) {
  document.querySelectorAll('.court-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
  document.getElementById('court').value = card.dataset.court;
  document.getElementById('selectedCourtLabel').textContent = `Court ${card.dataset.court}`;
  loadAvailableSlots();
  setTimeout(() => goToStep(2), 300);
}

// ─── STEP 2 ──────────────────────────────────────────────────────────────────
function setMinDate() {
  const today = new Date().toISOString().split('T')[0];
  const el    = document.getElementById('date');
  el.min      = today;
  el.value    = today;
  loadPricing();
  loadAvailableSlots();
}

async function loadAvailableSlots() {
  const date = document.getElementById('date').value;
  const court = document.getElementById('court').value;
  const sel  = document.getElementById('startTime');
  if (!date) return;
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const qs = court ? `?court=${encodeURIComponent(court)}` : '';
    const res  = await fetch(`${API_BASE}/available-slots/${date}${qs}`);
    if (!res.ok) {
      const errText = await res.text();
      console.error('Slots API error:', res.status, errText);
      throw new Error(`Server error ${res.status}`);
    }
    const data = await res.json();
    sel.innerHTML = '<option value="">Select start time</option>';
    if (data.availableSlots && data.availableSlots.length) {
      data.availableSlots.forEach(slot => {
        const o = document.createElement('option');
        o.value = slot; o.textContent = formatTime(slot);
        sel.appendChild(o);
      });
    } else {
      sel.innerHTML = '<option disabled>No slots available for this date</option>';
    }
  } catch (err) {
    console.error('loadAvailableSlots error:', err);
    sel.innerHTML = '<option value="">Select start time</option>';
  }
}

function updatePrice() {
  const d = parseInt(document.getElementById('duration').value) || 0;
  const rate = pricingRates.find(r => r.duration_hours === d);
  document.getElementById('totalPrice').textContent = rate ? `₱${Number(rate.price_amount).toLocaleString()}` : '₱0';
}

// ─── DYNAMIC SITE DATA (courts, pricing, settings) ───────────────────────────
async function loadSiteData() {
  try {
    const [courtsRes, settingsRes, pricingRes] = await Promise.all([
      fetch(`${API_BASE}/courts`),
      fetch(`${API_BASE}/website-settings`),
      fetch(`${API_BASE}/pricing`)
    ]);
    if (courtsRes.ok) courts = await courtsRes.json();
    if (settingsRes.ok) settings = await settingsRes.json();
    if (pricingRes.ok) applyStartingRate(await pricingRes.json());
  } catch (err) {
    console.warn('Could not load site data:', err.message);
  }
  applySettings();
  renderCourts();
}

function applyStartingRate(data) {
  const rates = (data && data.rates) || [];
  if (!rates.length) return;
  let minPerHour = Infinity;
  rates.forEach(r => {
    const perHour = Number(r.price_amount) / Number(r.duration_hours);
    if (perHour < minPerHour) minPerHour = perHour;
  });
  const statRate = document.getElementById('statRate');
  if (statRate && isFinite(minPerHour)) {
    statRate.textContent = `₱${minPerHour.toLocaleString(undefined, { maximumFractionDigits: 2 })}/hr`;
  }
}

function applySettings() {
  if (!settings) return;
  const name = settings.site_name || 'Velarde Courtside';
  document.title = `${name} - Pickleball Court Booking`;
  const heroName = document.getElementById('heroSiteName');
  if (heroName) heroName.textContent = name;
  if (settings.logo_url) {
    const logo = document.getElementById('siteLogo');
    if (logo) logo.src = settings.logo_url;
  }
  if (settings.operating_hours_start && settings.operating_hours_end) {
    const fmt = t => {
      const h = parseInt(t.split(':')[0]);
      return `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? 'PM' : 'AM'}`;
    };
    const hours = `${fmt(settings.operating_hours_start)}–${fmt(settings.operating_hours_end)}`;
    const statHours = document.getElementById('statHours');
    if (statHours) statHours.textContent = hours;
    const footerNote = document.getElementById('footerNote');
    if (footerNote) footerNote.textContent = `Open Daily · ${fmt(settings.operating_hours_start)} – ${fmt(settings.operating_hours_end)} · Walk-ins welcome based on availability`;
  }
}

function renderCourts() {
  const showcase = document.getElementById('courtsShowcase');
  const grid     = document.getElementById('courtGrid');
  const active   = courts.filter(c => c.status === 'active');

  if (showcase) {
    if (active.length === 0) {
      showcase.innerHTML = '<p>No courts available right now. Please check back soon.</p>';
    } else {
      showcase.innerHTML = active.map(c => {
        const media = c.image_url
          ? `<img class="showcase-image" src="${escapeHtml(c.image_url)}" alt="Court ${escapeHtml(String(c.court_number))}${c.name ? ' — ' + escapeHtml(c.name) : ''}" loading="lazy">`
          : `<div class="showcase-icon">${escapeHtml(String(c.court_number))}</div>`;
        return `
          <div class="showcase-card">
            ${media}
            <h3>Court ${escapeHtml(String(c.court_number))}${c.name ? ` — ${escapeHtml(c.name)}` : ''}</h3>
            <p>${escapeHtml(c.description || 'Professional-grade pickleball court.')}</p>
          </div>
        `;
      }).join('');
    }
  }

  if (grid) {
    if (active.length === 0) {
      grid.innerHTML = '<p>No courts available right now.</p>';
    } else {
      grid.innerHTML = active.map(c => `
        <button type="button" class="court-card" data-court="${escapeHtml(String(c.court_number))}">
          <span class="court-number">${escapeHtml(String(c.court_number))}</span>
          <span class="court-name">Court ${escapeHtml(String(c.court_number))}</span>
          <span class="court-status">${escapeHtml(c.name || 'Available')}</span>
        </button>
      `).join('');
    }
  }

  const statCourts = document.getElementById('statCourts');
  if (statCourts) statCourts.textContent = String(active.length);
  const badge = document.getElementById('heroBadge');
  if (badge) badge.textContent = `🏓 Now open · ${active.length} court${active.length === 1 ? '' : 's'} available`;
}

async function loadPricing() {
  const date = document.getElementById('date').value;
  const sel  = document.getElementById('duration');
  if (!date) return;
  try {
    const res = await fetch(`${API_BASE}/pricing?date=${encodeURIComponent(date)}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    pricingRates = data.rates || [];

    const current = parseInt(sel.value) || 0;
    sel.innerHTML = '<option value="">Select duration</option>';
    pricingRates.forEach(r => {
      const o = document.createElement('option');
      o.value = r.duration_hours;
      const base = Number(r.price_amount);
      o.textContent = `${r.duration_hours} Hour${r.duration_hours > 1 ? 's' : ''} — ₱${base.toLocaleString()}`;
      sel.appendChild(o);
    });
    if (current) sel.value = String(current);
    updatePrice();
  } catch (err) {
    console.error('loadPricing error:', err);
    sel.innerHTML = '<option value="">Select duration</option>';
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// *** Main handler — triggered by button click, not form submit ***
async function handleContinueClick() {
  const name      = document.getElementById('name').value.trim();
  const email     = document.getElementById('email').value.trim();
  const phone     = document.getElementById('phone').value.trim();
  const court     = document.getElementById('court').value;
  const date      = document.getElementById('date').value;
  const startTime = document.getElementById('startTime').value;
  const duration  = parseInt(document.getElementById('duration').value);

  // Validate each field and show clear error
  if (!court)     { showNotification('Please select a court first', 'error'); goToStep(1); return; }
  if (!name)      { showNotification('Please enter your full name', 'error'); return; }
  if (!email)     { showNotification('Please enter your email address', 'error'); return; }
  if (!phone)     { showNotification('Please enter your phone number', 'error'); return; }
  if (!date)      { showNotification('Please select a booking date', 'error'); return; }
  if (!startTime) { showNotification('Please select a start time', 'error'); return; }
  if (!duration)  { showNotification('Please select a duration', 'error'); return; }

  const btn = document.getElementById('continueToPaymentBtn');
  btn.disabled    = true;
  btn.textContent = 'Processing…';

  try {
    // 1. Save user
    const userRes = await fetch(`${API_BASE}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone })
    });
    if (!userRes.ok) throw new Error('Could not save your details');
    currentUser = await userRes.json();

    // 2. Create booking (price + end time computed server-side)
    const bookRes = await fetch(`${API_BASE}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId:        currentUser.id,
        courtNumber:   parseInt(court),
        bookingDate:   date,
        startTime,
        durationHours: duration
      })
    });
    if (!bookRes.ok) {
      const errData = await bookRes.json().catch(() => ({}));
      throw new Error(errData.error || 'Could not create booking');
    }
    const bookData = await bookRes.json();
    const price    = Number(bookData.priceAmount);
    const endTime  = bookData.endTime;

    // 3. Store state
    currentBooking = {
      ...bookData,
      customerName: name,
      duration,
      courtNumber:  parseInt(court),
      bookingDate:  date,
      startTime,
      endTime,
      priceAmount:  price
    };

    // 4. Fill summary panel
    document.getElementById('payCourt').textContent    = `Court ${court}`;
    document.getElementById('payDate').textContent     = formatDate(date);
    document.getElementById('payTime').textContent     = `${formatTime(startTime)} – ${formatTime(endTime)}`;
    document.getElementById('payDuration').textContent = `${duration} hour${duration > 1 ? 's' : ''}`;
    document.getElementById('payAmount').textContent   = `₱${price.toLocaleString()}`;

    goToStep(3);

  } catch (err) {
    console.error(err);
    showNotification(err.message || 'Something went wrong. Please try again.', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Continue to Payment →';
  }
}

// ─── STEP 3 ──────────────────────────────────────────────────────────────────
async function confirmBooking() {
  const btn = document.getElementById('confirmBookingBtn');
  btn.disabled    = true;
  btn.textContent = 'Processing…';

  try {
    if (paymentMethod === 'gcash') {
      const ref = document.getElementById('gcashRef').value.trim();
      if (!ref) { showNotification('Please enter your GCash reference number', 'error'); return; }

      const res = await fetch(`${API_BASE}/payments/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId:      currentBooking.paymentId,
          bookingId:      currentBooking.bookingId,
          userId:         currentUser.id,
          amount:         currentBooking.priceAmount,
          gcashReference: ref
        })
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.error || 'Payment failed');
      currentBooking.gcashRef = ref;
      showSuccessModal(true);

    } else {
      const res = await fetch(`${API_BASE}/payments/counter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: currentBooking.paymentId })
      });
      if (!res.ok) throw new Error('Could not save reservation');
      showSuccessModal(false);
    }
  } catch (err) {
    console.error(err);
    showNotification(err.message || 'Something went wrong. Please try again.', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Confirm Booking ✓';
  }
}

// ─── SUCCESS MODAL ───────────────────────────────────────────────────────────
function showSuccessModal(paid) {
  const b = currentBooking;
  document.getElementById('successTitle').textContent   = paid ? 'Booking Confirmed!' : 'Slot Reserved!';
  document.getElementById('successMessage').textContent = paid
    ? 'Payment received! Your court is booked. See you on the court!'
    : 'Slot reserved. Please pay at the counter at least 10 minutes before your schedule.';

  const ref = b.bookingId.slice(0, 8).toUpperCase();
  document.getElementById('receiptRef').textContent     = ref;
  document.getElementById('receiptCourt').textContent   = `Court ${b.courtNumber}`;
  document.getElementById('receiptDate').textContent    = formatDate(b.bookingDate);
  document.getElementById('receiptTime').textContent    = `${formatTime(b.startTime)} – ${formatTime(b.endTime)}`;
  document.getElementById('receiptPayment').textContent = paid ? `GCash (Ref: ${b.gcashRef})` : 'Pay at Counter';
  document.getElementById('receiptAmount').textContent  = `₱${b.priceAmount.toLocaleString()}`;

  document.getElementById('successModal').style.display = 'flex';
}

// ─── RECEIPT ─────────────────────────────────────────────────────────────────
function downloadReceipt() {
  const paid = paymentMethod === 'gcash';
  const b    = currentBooking;
  const ref  = b.bookingId.slice(0, 8).toUpperCase();

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Receipt ${ref}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:420px;margin:40px auto;color:#1c2b3a}
  .head{text-align:center;border-bottom:3px solid #d9f522;padding-bottom:16px;margin-bottom:20px}
  .head h1{margin:0;font-size:22px;color:#3b5323;text-transform:uppercase}
  .head p{margin:4px 0 0;color:#5a6b7c;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-bottom:20px}
  td{padding:8px 0;border-bottom:1px solid #e5edf4;font-size:14px}
  td:first-child{color:#5a6b7c}td:last-child{text-align:right;font-weight:bold}
  tr.total td{border-top:2px solid #d9f522;border-bottom:none;font-size:17px;padding-top:12px}
  .badge{display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:bold;
    background:${paid?'#d4edda':'#fff3cd'};color:${paid?'#155724':'#856404'}}
  .foot{text-align:center;color:#8fa0b0;font-size:12px;margin-top:24px}
</style></head>
<body onload="window.print()">
  <div class="head"><h1>Velarde Courtside</h1><p>Pickleball Court Booking Receipt</p></div>
  <p>Ref: <strong>${ref}</strong> &nbsp; <span class="badge">${paid?'PAID – GCash':'PENDING – Pay at Counter'}</span></p>
  <table>
    <tr><td>Customer</td><td>${b.customerName}</td></tr>
    <tr><td>Court</td><td>Court ${b.courtNumber}</td></tr>
    <tr><td>Date</td><td>${formatDate(b.bookingDate)}</td></tr>
    <tr><td>Time</td><td>${formatTime(b.startTime)} – ${formatTime(b.endTime)}</td></tr>
    <tr><td>Duration</td><td>${b.duration} hour${b.duration>1?'s':''}</td></tr>
    ${paid?`<tr><td>GCash Ref</td><td>${b.gcashRef}</td></tr>`:''}
    <tr class="total"><td>Total</td><td>₱${b.priceAmount.toLocaleString()}</td></tr>
  </table>
  <p style="font-size:13px;color:#5a6b7c">Please arrive 10 minutes before your scheduled time.</p>
  <div class="foot">Velarde Courtside · Open Daily 7:00 AM – 7:00 PM<br>Thank you for booking!</div>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `receipt-${ref}.html`; a.click();
  URL.revokeObjectURL(url);
  showNotification('Receipt downloaded!', 'success');
}

function resetFlow() {
  document.getElementById('successModal').style.display = 'none';
  document.getElementById('bookingForm').reset();
  document.getElementById('gcashRef').value = '';
  document.getElementById('court').value    = '';
  document.getElementById('selectedCourtLabel').textContent = 'Court -';
  document.querySelectorAll('.court-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('totalPrice').textContent = '₱0';
  currentBooking = null; currentUser = null;
  setMinDate();
  goToStep(1);
}

// ─── PAYMENT METHODS (load QR from admin settings) ───────────────────────────
async function loadPaymentMethods() {
  try {
    const res     = await fetch(`${API_BASE}/payment-methods`);
    const methods = await res.json();

    const gcash = methods.find(m => m.is_active && m.method_name.toLowerCase().includes('gcash'));
    if (!gcash) return;

    // Update QR image (both inline and modal)
    if (gcash.qr_code_url) {
      const qrImg = document.getElementById('gcashQrImg');
      const qrModalImg = document.getElementById('qrModalImg');
      if (qrImg)      qrImg.src      = gcash.qr_code_url;
      if (qrModalImg) qrModalImg.src = gcash.qr_code_url;
    }

    // Update account number
    if (gcash.account_details) {
      const numEl = document.getElementById('gcashAccountNumber');
      if (numEl) numEl.textContent = gcash.account_details;
    }

    // Update account name
    if (gcash.description) {
      const nameEl = document.getElementById('gcashAccountName');
      if (nameEl) nameEl.textContent = gcash.description;
    }

  } catch (err) {
    console.warn('Could not load payment methods:', err.message);
  }
}

function openQrModal() {
  const modal = document.getElementById('qrModal');
  if (modal) modal.classList.add('open');
}

function closeQrModal() {
  const modal = document.getElementById('qrModal');
  if (modal) modal.classList.remove('open');
}

// Close QR modal on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeQrModal();
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function formatTime(t) {
  const h = parseInt(t.split(':')[0]);
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${h >= 12 ? 'PM' : 'AM'}`;
}

function formatDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}

function showNotification(msg, type = 'info') {
  document.querySelectorAll('.notif-toast').forEach(n => n.remove());
  const el = document.createElement('div');
  el.className  = 'notif-toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = msg;
  el.style.cssText = `
    position:fixed;top:24px;right:24px;z-index:9999;
    padding:.875rem 1.5rem;border-radius:8px;color:#fff;
    font-size:.95rem;font-weight:600;max-width:320px;
    box-shadow:0 4px 16px rgba(0,0,0,.2);
    animation:_toastIn .25s ease;
    background:${type==='success'?'#10b981':type==='error'?'#ef4444':'#3b82f6'};
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

document.head.insertAdjacentHTML('beforeend', `<style>
  @keyframes _toastIn { from{transform:translateX(110%);opacity:0} to{transform:translateX(0);opacity:1} }
  #successModal{display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);
    align-items:center;justify-content:center;}
</style>`);
