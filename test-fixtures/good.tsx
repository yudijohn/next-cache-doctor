import { cacheLife, cacheTag } from 'next/cache';

export async function getBlogPost(slug: string) {
  'use cache';
  cacheTag(`post-${slug}`);
  cacheLife('days');

  return db.posts.findBySlug(slug);
}

export async function getSettings() {
  'use cache';
  cacheLife('max');
  return fetchSettings();
}
