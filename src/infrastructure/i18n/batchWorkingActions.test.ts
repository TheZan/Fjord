import i18next from "i18next";
import { describe, expect, it } from "vitest";
import deWorkspace from "@/locales/de/workspace.json";
import enWorkspace from "@/locales/en/workspace.json";
import esWorkspace from "@/locales/es/workspace.json";
import frWorkspace from "@/locales/fr/workspace.json";
import ruWorkspace from "@/locales/ru/workspace.json";

const catalogs = {
  en: enWorkspace,
  ru: ruWorkspace,
  de: deWorkspace,
  es: esWorkspace,
  fr: frWorkspace,
};

describe("Working Changes batch-action catalogs", () => {
  it("keeps every MULTI-02 key in all five locales", () => {
    const required = [
      "stageFiles_one",
      "stageFiles_other",
      "unstageFiles_one",
      "unstageFiles_other",
      "stashFiles_one",
      "stashFiles_other",
      "copyPaths",
    ];
    const workingChangesRequired = [
      "selectedCount_one",
      "selectedCount_other",
      "selectionActions_one",
      "selectionActions_other",
      "clearSelection",
    ];

    for (const catalog of Object.values(catalogs)) {
      for (const key of required) expect(catalog.workingFile).toHaveProperty(key);
      for (const key of workingChangesRequired) {
        expect(catalog.workingChanges).toHaveProperty(key);
      }
    }
    for (const stem of ["stageFiles", "unstageFiles", "stashFiles"]) {
      for (const suffix of ["one", "few", "many", "other"]) {
        expect(ruWorkspace.workingFile).toHaveProperty(`${stem}_${suffix}`);
      }
    }
  });

  it("resolves singular and counted labels through i18next plural selection", async () => {
    const translator = i18next.createInstance();
    await translator.init({
      lng: "en",
      fallbackLng: false,
      resources: { en: { workspace: enWorkspace } },
      defaultNS: "workspace",
      interpolation: { escapeValue: false },
    });

    expect(translator.t("workingFile.stageFiles", { count: 1 })).toBe("Stage");
    expect(translator.t("workingFile.stageFiles", { count: 4 })).toBe("Stage 4 files");
    expect(translator.t("workingFile.unstageFiles", { count: 3 })).toBe("Unstage 3 files");
    expect(translator.t("workingFile.stashFiles", { count: 4 })).toBe("Stash 4 files…");
  });
});
