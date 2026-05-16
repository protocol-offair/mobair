import { describe, expect, it } from "vitest";

import {
  formatBirthDateInput,
  formatBirthDateIsoForInput,
  formatCpfInput,
  formatCpfOrCnpjInput,
  formatCnpjInput,
  formatDocumentForDisplay,
  formatWalletDocumentInput,
  normalizeDecimalInput,
  normalizeDocumentForStorage,
  parseBirthDateInputToIso,
} from "./inputFormatters";

describe("inputFormatters", () => {
  it("formats cpf and cnpj masks", () => {
    expect(formatCpfInput("12345678901")).toBe("123.456.789-01");
    expect(formatCnpjInput("12345678000199")).toBe("12.345.678/0001-99");
    expect(formatCpfOrCnpjInput("12345678901")).toBe("123.456.789-01");
    expect(formatCpfOrCnpjInput("12345678000199")).toBe("12.345.678/0001-99");
    expect(formatWalletDocumentInput("12345678901", "individual")).toBe("123.456.789-01");
    expect(formatWalletDocumentInput("12345678000199", "business")).toBe("12.345.678/0001-99");
  });

  it("normalizes masked documents for storage", () => {
    expect(normalizeDocumentForStorage("123.456.789-01", "cpf")).toBe("12345678901");
    expect(normalizeDocumentForStorage("12.345.678/0001-99", "cnpj")).toBe("12345678000199");
    expect(formatDocumentForDisplay("12345678901", "cpf")).toBe("123.456.789-01");
  });

  it("formats and parses birth dates", () => {
    expect(formatBirthDateInput("01011999")).toBe("01/01/1999");
    expect(formatBirthDateIsoForInput("1999-01-01")).toBe("01/01/1999");
    expect(parseBirthDateInputToIso("01/01/1999")).toBe("1999-01-01");
    expect(parseBirthDateInputToIso("31/02/1999")).toBeNull();
  });

  it("normalizes decimal input for sol amount fields", () => {
    expect(normalizeDecimalInput("1,25")).toBe("1.25");
    expect(normalizeDecimalInput("001.250")).toBe("001.250");
    expect(normalizeDecimalInput(".5")).toBe("0.5");
  });
});
