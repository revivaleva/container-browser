async function cleanup() {
  const KAMELEO_API = 'http://localhost:5050';
  try {
    const resp = await fetch(`${KAMELEO_API}/profiles`);
    const profiles = await resp.json();
    const array = Array.isArray(profiles) ? profiles : (profiles.value || []);
    for (const p of array) {
      const id = p.id || p.guid;
      if (p.status && p.status.lifetimeState !== 'created') {
        console.log(`Stopping profile ${id}...`);
        await fetch(`${KAMELEO_API}/profiles/${id}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
      }
    }
    console.log('Cleanup complete.');
  } catch (err) {
    console.error('Cleanup failed:', err);
  }
}
cleanup();
