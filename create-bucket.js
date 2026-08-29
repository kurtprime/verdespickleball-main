// create-bucket.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function createBucket() {
  const { data, error } = await supabase.storage.createBucket('uploads', {
    public: true,
    allowedMimeTypes: ['image/*'],
    fileSizeLimit: 15 * 1024 * 1024, // 15MB
  });

  if (error) {
    if (error.message.includes('already exists')) {
      console.log('✅ Bucket "uploads" already exists.');
    } else {
      console.error('❌ Error creating bucket:', error.message);
    }
  } else {
    console.log('✅ Bucket "uploads" created successfully!');
    console.log('Details:', data);
  }
}

createBucket();