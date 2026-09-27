/**
 * Utilities for WhatsApp link generation and CSV export in prospecting results.
 */

/**
 * Normalizes a phone number to real E.164 format (leading `+`, digits only
 * after that) — the format `contacts.phone_number` requires at the database
 * level (`contacts_phone_e164_format` CHECK, `^\+\d{8,15}$`).
 *
 * Input: raw phone number as stored in database (may have spaces, dashes, etc.)
 * Output: `+55...` for Brazilian numbers, or null if it can't be normalized.
 *
 * If the input is invalid/null, returns null.
 */
export function normalizePhoneToE164(phoneNumber: string | null | undefined): string | null {
  if (!phoneNumber || typeof phoneNumber !== "string") {
    return null;
  }

  // Remove all non-digit characters
  const digitsOnly = phoneNumber.replace(/\D/g, "");

  // If it's empty after removing non-digits, return null
  if (!digitsOnly) {
    return null;
  }

  // If it doesn't start with 55 (Brazil country code), prepend it
  // Assuming Brazilian phone numbers (11-9XXXX-XXXX format when stored)
  if (digitsOnly.startsWith("55")) {
    // Already has country code
    return digitsOnly.length >= 12 ? `+${digitsOnly}` : null;
  }

  // Brazilian format: (XX)9XXXX-XXXX is 10 digits, prepend 55
  if (digitsOnly.length === 10 || digitsOnly.length === 11) {
    return `+55${digitsOnly}`;
  }

  return null;
}

/**
 * Builds a WhatsApp link with pre-filled message.
 *
 * Returns a valid wa.me URL if the phone number is valid, or null if invalid.
 */
export function buildWhatsAppLink(
  phoneNumber: string | null | undefined,
  companyName: string | null | undefined,
): string | null {
  const normalizedPhone = normalizePhoneToE164(phoneNumber);
  if (!normalizedPhone) {
    return null;
  }

  const companyText = companyName ? ` ${companyName}` : "sua empresa";
  const message = `Olá! Vi que${companyText} ainda não tem um site — a Black Talk Digital pode ajudar com isso. Podemos conversar?`;

  const encodedMessage = encodeURIComponent(message);
  // wa.me quer só dígitos, sem o "+" que o E.164 exige — normalizePhoneToE164
  // devolve E.164 de verdade (formato que contacts.phone_number exige no
  // banco); aqui é o único lugar que converte pro formato que o wa.me espera.
  return `https://wa.me/${normalizedPhone.replace(/^\+/, "")}?text=${encodedMessage}`;
}

/**
 * Escapes a value for CSV output (handles commas, quotes, newlines).
 */
export function escapeCsvValue(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);

  // If value contains comma, newline, or quote, wrap in quotes and escape quotes
  if (stringValue.includes(",") || stringValue.includes('"') || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * Builds a CSV content string from prospected places.
 *
 * Columns: name, address, phone, email, site, rating, score, status
 *
 * Returns a string with headers and data rows, ready to download.
 */
export function buildCsvContent(places: Array<{
  name: string;
  address: string | null;
  phoneNumber: string | null;
  email: string | null;
  websiteUrl: string | null;
  rating: number | null;
  scoreFinal: number | null;
  scoreInitial: number;
  statusLabel: string;
}>): string {
  const headers = ["Empresa", "Endereço", "Telefone", "E-mail", "Site", "Rating", "Score", "Status"];
  const headerRow = headers.map((h) => escapeCsvValue(h)).join(",");

  const dataRows = places.map((place) => {
    const score = place.scoreFinal ?? place.scoreInitial;
    const cells = [
      place.name,
      place.address,
      place.phoneNumber,
      place.email,
      place.websiteUrl,
      place.rating != null ? place.rating.toFixed(1) : null,
      score.toString(),
      place.statusLabel,
    ];
    return cells.map((cell) => escapeCsvValue(cell)).join(",");
  });

  return [headerRow, ...dataRows].join("\n");
}
