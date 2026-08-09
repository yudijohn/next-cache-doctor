import { cookies } from 'next/headers';
import { cacheLife } from 'next/cache';

// BUG: this reads the user's session cookie but caches the result with the
// SHARED 'use cache' directive -> other users could get this user's data.
export async function getUserDashboard() {
  'use cache';
  cacheLife('minutes');

  const cookieStore = cookies();
  const sessionId = cookieStore.get('session')?.value;
  return db.dashboards.findBySession(sessionId);
}

export async function searchResults({ searchParams }: { searchParams: any }) {
  'use cache';
  cacheLife('minutes');

  return db.search(searchParams.q);
}
