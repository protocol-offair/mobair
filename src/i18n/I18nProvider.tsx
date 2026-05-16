import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import {
  getCurrentLocale,
  initializeLocale,
  setCurrentLocale,
  subscribeLocale,
  t,
  type SupportedLocale,
} from "./index";

interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => Promise<void>;
  t: typeof t;
}

const I18nContext = createContext<I18nContextValue>({
  locale: getCurrentLocale(),
  setLocale: setCurrentLocale,
  t,
});

export function I18nProvider(props: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(getCurrentLocale());

  useEffect(() => {
    let mounted = true;

    void initializeLocale().then((resolvedLocale) => {
      if (mounted) {
        setLocaleState(resolvedLocale);
      }
    });

    return subscribeLocale((nextLocale) => {
      if (mounted) {
        setLocaleState(nextLocale);
      }
    });
  }, []);

  return (
    <I18nContext.Provider
      value={{
        locale,
        setLocale: async (nextLocale) => {
          await setCurrentLocale(nextLocale);
        },
        t,
      }}
    >
      {props.children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
