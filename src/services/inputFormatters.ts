import type { DocumentType, WalletType } from "@airpay/shared";

export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

export function normalizeDocumentForStorage(value: string, documentType: DocumentType): string {
  if (documentType === "cpf" || documentType === "cnpj") {
    return digitsOnly(value);
  }
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeLooseDocumentInput(value: string): string {
  const digits = digitsOnly(value);
  return digits || value.trim().replace(/\s+/g, " ");
}

function formatWithGroups(value: string, groups: number[], separators: string[]): string {
  const result: string[] = [];
  let cursor = 0;

  groups.forEach((groupSize, index) => {
    if (cursor >= value.length) {
      return;
    }
    const chunk = value.slice(cursor, cursor + groupSize);
    if (!chunk) {
      return;
    }
    if (index > 0 && result.length > 0) {
      result.push(separators[index - 1] ?? "");
    }
    result.push(chunk);
    cursor += groupSize;
  });

  if (cursor < value.length) {
    result.push(value.slice(cursor));
  }

  return result.join("");
}

export function formatCpfInput(value: string): string {
  return formatWithGroups(digitsOnly(value).slice(0, 11), [3, 3, 3, 2], [".", ".", "-"]);
}

export function formatCnpjInput(value: string): string {
  return formatWithGroups(digitsOnly(value).slice(0, 14), [2, 3, 3, 4, 2], [".", ".", "/", "-"]);
}

export function formatCpfOrCnpjInput(value: string): string {
  const digits = digitsOnly(value);
  return digits.length > 11 ? formatCnpjInput(digits) : formatCpfInput(digits);
}

export function formatWalletDocumentInput(value: string, walletType: WalletType): string {
  return walletType === "individual" ? formatCpfInput(value) : formatCnpjInput(value);
}

export function formatDocumentForDisplay(value: string, documentType: DocumentType): string {
  if (documentType === "cpf") {
    return formatCpfInput(value);
  }
  if (documentType === "cnpj") {
    return formatCnpjInput(value);
  }
  return value;
}

export function formatBirthDateInput(value: string): string {
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${day}/${month}/${year}`;
  }
  const digits = digitsOnly(value).slice(0, 8);
  return formatWithGroups(digits, [2, 2, 4], ["/", "/"]);
}

export function formatBirthDateIsoForInput(value?: string | null): string {
  if (!value) {
    return "";
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return formatBirthDateInput(value);
  }
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return false;
  }
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return candidate.getTime() <= todayUtc;
}

export function parseBirthDateInputToIso(value?: string | null): string | null {
  if (!value?.trim()) {
    return null;
  }

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return isValidDateParts(Number(year), Number(month), Number(day)) ? value : null;
  }

  const digits = digitsOnly(value);
  if (digits.length !== 8) {
    return null;
  }

  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4, 8));
  if (!isValidDateParts(year, month, day)) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isValidIsoBirthDate(value?: string | null): boolean {
  return Boolean(parseBirthDateInputToIso(value));
}

export function normalizeDecimalInput(value: string): string {
  const sanitized = value.replace(/,/g, ".").replace(/[^\d.]/g, "");
  if (!sanitized) {
    return "";
  }

  const dotIndex = sanitized.indexOf(".");
  if (dotIndex === -1) {
    return sanitized;
  }

  const wholePart = sanitized.slice(0, dotIndex) || "0";
  const fractionalPart = sanitized.slice(dotIndex + 1).replace(/\./g, "");
  return `${wholePart}.${fractionalPart}`;
}
