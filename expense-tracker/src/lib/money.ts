/** Amounts are integer hundredths of the currency unit, whatever the currency. */
export const SCALE = 100;

const MAX_WHOLE_DIGITS = 12;

/**
 * Parses what someone typed into an amount field. Accepts "1250", "1,250.50",
 * "12.5" and a decimal comma ("12,50"). Returns hundredths, or null when the
 * text is not a positive amount with at most two decimals.
 */
export function parseAmount(input: string): number | null {
  let text = input.trim().replace(/[\s  ']/g, '');
  if (!text.includes('.') && /^\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.');
  else text = text.replace(/,/g, '');
  const match = new RegExp(`^(\\d{0,${MAX_WHOLE_DIGITS}})(?:\\.(\\d{0,2}))?$`).exec(text);
  if (!match || (match[1] === '' && !match[2])) return null;
  const value = Number(match[1] || '0') * SCALE + Number((match[2] ?? '').padEnd(2, '0'));
  return value > 0 ? value : null;
}

/** The text to pre-fill an amount field with when editing. */
export function amountToInput(amount: number): string {
  const whole = Math.floor(amount / SCALE);
  const cents = amount % SCALE;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, fractions: boolean, sign: boolean): Intl.NumberFormat {
  const key = `${currency}|${fractions}|${sign}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      ...(fractions ? {} : { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
      ...(sign ? { signDisplay: 'exceptZero' } : {}),
    });
    formatters.set(key, format);
  }
  return format;
}

export interface MoneyFormat {
  /** Short form for chart axes: ₹1.2K. Whole units below a thousand. */
  compact?: boolean;
  /** Always show + or −. */
  sign?: boolean;
}

const COMPACT_STEPS: [number, string][] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/**
 * Formats hundredths as currency. Whole amounts drop their ".00". Compact uses
 * K/M/B everywhere, since some locales' short forms ("₹30T" in en-IN) read oddly.
 */
export function formatMoney(amount: number, currency: string, options: MoneyFormat = {}): string {
  const units = amount / SCALE;
  const step = options.compact ? COMPACT_STEPS.find(([size]) => Math.abs(units) >= size) : undefined;
  if (step) {
    const [size, suffix] = step;
    const short = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Math.abs(units) / size);
    return formatter(currency, false, options.sign ?? false)
      .formatToParts(units < 0 ? -1 : 1)
      .map((part) => (part.type === 'integer' ? `${short}${suffix}` : part.value))
      .join('')
      .replace('-', '−');
  }
  return formatter(currency, amount % SCALE !== 0, options.sign ?? false)
    .format(units)
    .replace('-', '−');
}

export function isSupportedCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

export const CURRENCIES = [
  'INR', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD', 'SGD', 'AED', 'SAR', 'QAR', 'KWD',
  'PKR', 'BDT', 'LKR', 'NPR', 'MYR', 'IDR', 'PHP', 'THB', 'VND', 'KRW', 'HKD', 'NZD', 'CHF',
  'SEK', 'NOK', 'DKK', 'PLN', 'TRY', 'RUB', 'UAH', 'ZAR', 'NGN', 'KES', 'EGP', 'BRL', 'MXN',
  'ARS', 'COP', 'CLP',
];

const TIMEZONE_CURRENCY: Record<string, string> = {
  'Asia/Kolkata': 'INR', 'Asia/Calcutta': 'INR', 'Asia/Karachi': 'PKR', 'Asia/Dhaka': 'BDT',
  'Asia/Colombo': 'LKR', 'Asia/Kathmandu': 'NPR', 'Asia/Katmandu': 'NPR', 'Asia/Dubai': 'AED',
  'Asia/Riyadh': 'SAR', 'Asia/Singapore': 'SGD', 'Asia/Tokyo': 'JPY', 'Asia/Shanghai': 'CNY',
  'Asia/Kuala_Lumpur': 'MYR', 'Asia/Jakarta': 'IDR', 'Asia/Manila': 'PHP', 'Asia/Bangkok': 'THB',
  'Asia/Seoul': 'KRW', 'Asia/Hong_Kong': 'HKD', 'Europe/London': 'GBP', 'Africa/Lagos': 'NGN',
  'Africa/Nairobi': 'KES', 'Africa/Johannesburg': 'ZAR', 'Africa/Cairo': 'EGP', 'America/Sao_Paulo': 'BRL',
  'America/Mexico_City': 'MXN',
};

const REGION_CURRENCY: Record<string, string> = {
  IN: 'INR', US: 'USD', GB: 'GBP', JP: 'JPY', CN: 'CNY', AU: 'AUD', CA: 'CAD', SG: 'SGD', AE: 'AED',
  SA: 'SAR', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR', MY: 'MYR', ID: 'IDR', PH: 'PHP', TH: 'THB',
  VN: 'VND', KR: 'KRW', HK: 'HKD', NZ: 'NZD', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN',
  TR: 'TRY', ZA: 'ZAR', NG: 'NGN', KE: 'KES', EG: 'EGP', BR: 'BRL', MX: 'MXN', DE: 'EUR', FR: 'EUR',
  ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR',
};

/**
 * A first guess at the person's currency. The time zone comes first because
 * many phones keep an en-US locale wherever they are.
 */
export function guessCurrency(timeZone?: string, locale?: string): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone && TIMEZONE_CURRENCY[zone]) return TIMEZONE_CURRENCY[zone];
  try {
    const region = new Intl.Locale(locale ?? navigator.language).maximize().region;
    if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  } catch {
    // An unparseable locale falls through to the default.
  }
  return 'USD';
}

export function currencyLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'currency' }).of(code);
    const symbol = new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value;
    return `${symbol && symbol !== code ? `${symbol} ` : ''}${code} · ${name ?? code}`;
  } catch {
    return code;
  }
}
