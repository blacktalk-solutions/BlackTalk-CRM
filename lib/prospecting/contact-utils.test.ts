import { describe, it, expect } from "vitest";
import {
  normalizePhoneToE164,
  buildWhatsAppLink,
  escapeCsvValue,
  buildCsvContent,
} from "./contact-utils";

describe("contact-utils", () => {
  describe("normalizePhoneToE164", () => {
    it("should return null for null/undefined input", () => {
      expect(normalizePhoneToE164(null)).toBeNull();
      expect(normalizePhoneToE164(undefined)).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(normalizePhoneToE164("")).toBeNull();
    });

    it("should prepend 55 to Brazilian 10-digit numbers", () => {
      expect(normalizePhoneToE164("1133334444")).toBe("551133334444");
    });

    it("should prepend 55 to Brazilian 11-digit numbers", () => {
      expect(normalizePhoneToE164("11999998888")).toBe("5511999998888");
    });

    it("should handle formatted Brazilian numbers", () => {
      expect(normalizePhoneToE164("(11) 9 9999-8888")).toBe("5511999998888");
      expect(normalizePhoneToE164("(11) 3333-4444")).toBe("551133334444");
    });

    it("should accept numbers already starting with 55", () => {
      expect(normalizePhoneToE164("551133334444")).toBe("551133334444");
      expect(normalizePhoneToE164("55 11 9999-8888")).toBe("5511999998888");
    });

    it("should return null for numbers with wrong length", () => {
      expect(normalizePhoneToE164("123")).toBeNull();
      expect(normalizePhoneToE164("12345")).toBeNull();
    });

    it("should return null for non-string input", () => {
      expect(normalizePhoneToE164(123 as never)).toBeNull();
    });
  });

  describe("buildWhatsAppLink", () => {
    it("should return null for invalid phone numbers", () => {
      expect(buildWhatsAppLink(null, "Test Company")).toBeNull();
      expect(buildWhatsAppLink("", "Test Company")).toBeNull();
      expect(buildWhatsAppLink("123", "Test Company")).toBeNull();
    });

    it("should build valid link with company name", () => {
      const link = buildWhatsAppLink("1133334444", "Acme Corp");
      expect(link).toBe(
        "https://wa.me/551133334444?text=Olá!%20Vi%20que%20Acme%20Corp%20ainda%20não%20tem%20um%20site%20—%20a%20Black%20Talk%20Digital%20pode%20ajudar%20com%20isso.%20Podemos%20conversar?"
      );
    });

    it("should handle company name with generic fallback", () => {
      const link = buildWhatsAppLink("1133334444", null);
      expect(link).toContain("sua empresa");
      expect(link).toContain("https://wa.me/551133334444");
    });

    it("should build valid link with formatted phone", () => {
      const link = buildWhatsAppLink("(11) 9 9999-8888", "Test Shop");
      expect(link).toContain("https://wa.me/5511999998888");
      expect(link).toContain("Test%20Shop");
    });
  });

  describe("escapeCsvValue", () => {
    it("should return empty string for null/undefined", () => {
      expect(escapeCsvValue(null)).toBe("");
      expect(escapeCsvValue(undefined)).toBe("");
    });

    it("should return simple strings unchanged", () => {
      expect(escapeCsvValue("simple")).toBe("simple");
      expect(escapeCsvValue("123")).toBe("123");
    });

    it("should quote and escape values with commas", () => {
      expect(escapeCsvValue("Smith, John")).toBe('"Smith, John"');
    });

    it("should quote and escape values with quotes", () => {
      expect(escapeCsvValue('He said "hello"')).toBe('"He said ""hello"""');
    });

    it("should quote values with newlines", () => {
      expect(escapeCsvValue("line1\nline2")).toBe('"line1\nline2"');
    });

    it("should handle numbers", () => {
      expect(escapeCsvValue("4.5")).toBe("4.5");
      expect(escapeCsvValue("100")).toBe("100");
    });
  });

  describe("buildCsvContent", () => {
    it("should build CSV with headers and data rows", () => {
      const places = [
        {
          name: "Acme Corp",
          address: "Rua A, 123",
          phoneNumber: "1133334444",
          email: "contact@acme.com",
          websiteUrl: "https://acme.com",
          rating: 4.5,
          scoreFinal: 85,
          scoreInitial: 75,
          statusLabel: "Quente",
        },
      ];

      const csv = buildCsvContent(places);
      const lines = csv.split("\n");

      expect(lines[0]).toBe("Empresa,Endereço,Telefone,E-mail,Site,Rating,Score,Status");
      expect(lines[1]).toContain("Acme Corp");
      expect(lines[1]).toContain("4.5");
      expect(lines[1]).toContain("85");
    });

    it("should handle null email", () => {
      const places = [
        {
          name: "No Email Co",
          address: "Rua B, 456",
          phoneNumber: "1144445555",
          email: null,
          websiteUrl: "https://noemail.com",
          rating: 3.2,
          scoreFinal: 65,
          scoreInitial: 60,
          statusLabel: "Oportunidade",
        },
      ];

      const csv = buildCsvContent(places);
      expect(csv).toContain("No Email Co");
      expect(csv).toContain("Oportunidade");
    });

    it("should escape company names with commas", () => {
      const places = [
        {
          name: "Smith, Johnson & Associates",
          address: "Street",
          phoneNumber: "1133334444",
          email: "test@test.com",
          websiteUrl: "https://test.com",
          rating: 4.0,
          scoreFinal: 80,
          scoreInitial: 75,
          statusLabel: "Quente",
        },
      ];

      const csv = buildCsvContent(places);
      expect(csv).toContain('"Smith, Johnson & Associates"');
    });

    it("should use scoreFinal if available, otherwise scoreInitial", () => {
      const places = [
        {
          name: "Company A",
          address: "A",
          phoneNumber: "1133334444",
          email: "a@a.com",
          websiteUrl: "https://a.com",
          rating: 4.0,
          scoreFinal: 90,
          scoreInitial: 70,
          statusLabel: "Quente",
        },
        {
          name: "Company B",
          address: "B",
          phoneNumber: "1133334444",
          email: "b@b.com",
          websiteUrl: "https://b.com",
          rating: 3.0,
          scoreFinal: null,
          scoreInitial: 50,
          statusLabel: "Baixa",
        },
      ];

      const csv = buildCsvContent(places);
      const lines = csv.split("\n");

      expect(lines[1]).toContain("90"); // Company A: scoreFinal
      expect(lines[2]).toContain("50"); // Company B: scoreInitial
    });
  });
});
