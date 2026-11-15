export function getApiToken(): string {
  if (typeof document === 'undefined') return '';
  const el = document.querySelector('meta[name="sniper-api-token"]');
  return el?.getAttribute('content')?.trim() || '';
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getApiToken();
  const headers = new Headers(init.headers || {});
  if (token) {
    headers.set('x-api-token', token);
  }
  return fetch(input, { ...init, headers });
}
