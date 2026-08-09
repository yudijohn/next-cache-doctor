import { cacheTag } from 'next/cache';

export async function getProducts() {
  'use cache';
  cacheTag('products');
  return fetch('/api/products');
}
