import create, { SetState } from 'zustand';
import { useCallback, useEffect, useState } from 'react';
import { omit, pick } from 'lodash';
import {
  Allies,
  Charge,
  ChargeUpdateInitial,
  scryAllies,
  scryAllyTreaties,
  scryCharges,
  scryDefaultAlly,
  Treaty,
  Docket,
  Treaties,
  AllyUpdateIni,
  AllyUpdateNew,
  TreatyUpdateIni,
  TreatyUpdate,
  docketInstall,
  ChargeUpdate,
  kilnRevive,
  kilnSuspend,
  allyShip,
} from '@/gear';
import api from '@/api';
import { asyncWithDefault, normalizeUrbitColor } from '@/logic/utils';
import { Status } from '@/logic/useAsyncCall';
import { ConnectionStatus, useConnectivityCheck } from './vitals';

export interface ChargeWithDesk extends Charge {
  desk: string;
}

export interface ChargesWithDesks {
  [ref: string]: ChargeWithDesk;
}

export interface DocketWithDesk extends Docket {
  desk: string;
}

interface DocketState {
  charges: ChargesWithDesks;
  treaties: Treaties;
  allies: Allies;
  defaultAlly: string | null;
  fetchCharges: () => Promise<void>;
  fetchDefaultAlly: () => Promise<void>;
  requestTreaty: (ship: string, desk: string) => Promise<void>;
  fetchAllies: () => Promise<Allies>;
  fetchAllyTreaties: (ally: string) => Promise<Treaties>;
  toggleDocket: (desk: string) => Promise<void>;
  installDocket: (ship: string, desk: string) => Promise<number | void>;
  uninstallDocket: (desk: string) => Promise<number | void>;
  //
  addAlly: (ship: string) => Promise<number>;
  set: SetState<DocketState>;
}

const useDocketState = create<DocketState>((set, get) => ({
  defaultAlly: null,
  fetchDefaultAlly: async () => {
    const defaultAlly = await api.scry<string>(scryDefaultAlly);
    set({ defaultAlly });
  },
  fetchCharges: async () => {
    const charg = (await api.scry<ChargeUpdateInitial>(scryCharges)).initial;

    const charges = Object.entries(charg).reduce(
      (obj: ChargesWithDesks, [key, value]) => {
        // eslint-disable-next-line no-param-reassign
        obj[key] = normalizeDocket(value as ChargeWithDesk, key);
        return obj;
      },
      {}
    );

    set({ charges });
  },
  fetchAllies: async () => {
    const allies = (await api.scry<AllyUpdateIni>(scryAllies)).ini;
    set({ allies });
    return allies;
  },
  fetchAllyTreaties: async (ally: string) => {
    let treaties = (await api.scry<TreatyUpdateIni>(scryAllyTreaties(ally)))
      .ini;
    treaties = normalizeDockets(treaties);
    set((s) => ({ treaties: { ...s.treaties, ...treaties } }));
    return treaties;
  },
  requestTreaty: async (ship: string, desk: string) => {
    const { treaties } = get();

    const key = `${ship}/${desk}`;
    if (key in treaties) {
      return;
    }

    const result = await asyncWithDefault(
      () => api.subscribeOnce<Treaty>('treaty', `/treaty/${key}`, 20000),
      null
    );

    const treaty = result ? { ...normalizeDocket(result, desk), ship } : null;
    set((state) => ({
      treaties: { ...state.treaties, [key]: treaty },
    }));
  },
  installDocket: async (ship: string, desk: string) => {
    const treaty = get().treaties[`${ship}/${desk}`];
    if (!treaty) {
      throw new Error('Bad install');
    }
    set((state) =>
      addCharge(state, desk, { ...treaty, chad: { install: null } })
    );

    await api.poke(docketInstall(ship, desk));
  },
  uninstallDocket: async (desk: string) => {
    set((state) => delCharge(state, desk));
    await api.poke({
      app: 'docket',
      mark: 'docket-uninstall',
      json: desk,
    });
  },
  toggleDocket: async (desk: string) => {
    const { charges } = get();
    const charge = charges[desk];
    if (!charge) {
      return;
    }
    const suspended = 'suspend' in charge.chad;
    if (suspended) {
      await api.poke(kilnRevive(desk));
    } else {
      await api.poke(kilnSuspend(desk));
    }
  },
  treaties: {},
  charges: {},
  allies: {},
  addAlly: async (ship) => {
    set((draft) => {
      draft.allies[ship] = [];
    });

    return api.poke(allyShip(ship));
  },
  set,
}));

function normalizeDocket<T extends Docket>(docket: T, desk: string): T {
  return {
    ...docket,
    desk,
    color: normalizeUrbitColor(docket.color),
  };
}

function normalizeDockets<T extends Docket>(
  dockets: Record<string, T>
): Record<string, T> {
  return Object.entries(dockets).reduce(
    (obj: Record<string, T>, [key, value]) => {
      const [, desk] = key.split('/');
      // eslint-disable-next-line no-param-reassign
      obj[key] = normalizeDocket(value, desk);
      return obj;
    },
    {}
  );
}

function addCharge(state: DocketState, desk: string, charge: Charge) {
  return {
    charges: {
      ...state.charges,
      [desk]: normalizeDocket(charge as ChargeWithDesk, desk),
    },
  };
}

function delCharge(state: DocketState, desk: string) {
  return { charges: omit(state.charges, desk) };
}

api.subscribe({
  app: 'docket',
  path: '/charges',
  event: (data: ChargeUpdate) => {
    useDocketState.setState((state) => {
      if ('add-charge' in data) {
        const { desk, charge } = data['add-charge'];
        return addCharge(state, desk, charge);
      }

      if ('del-charge' in data) {
        const desk = data['del-charge'];
        return delCharge(state, desk);
      }

      return { charges: state.charges };
    });
  },
});

api.subscribe({
  app: 'treaty',
  path: '/treaties',
  event: (data: TreatyUpdate) => {
    useDocketState.getState().set((draft) => {
      if ('add' in data) {
        const { ship, desk } = data.add;
        const treaty = normalizeDocket(data.add, desk);
        draft.treaties[`${ship}/${desk}`] = treaty;
      }

      if ('ini' in data) {
        const treaties = normalizeDockets(data.ini);
        draft.treaties = { ...draft.treaties, ...treaties };
      }
    });
  },
});

api.subscribe({
  app: 'treaty',
  path: '/allies',
  event: (data: AllyUpdateNew) => {
    useDocketState.getState().set((draft) => {
      if ('new' in data) {
        const { ship, alliance } = data.new;
        draft.allies[ship] = alliance;
      }
    });
  },
});

const selCharges = (s: DocketState) => {
  return s.charges;
};

export function useCharges() {
  return useDocketState(selCharges);
}

export function useCharge(desk: string) {
  return useDocketState(useCallback((state) => state.charges[desk], [desk]));
}

const selRequest = (s: DocketState) => s.requestTreaty;
export function useRequestDocket() {
  return useDocketState(selRequest);
}

const selAllies = (s: DocketState) => s.allies;
export function useAllies() {
  return useDocketState(selAllies);
}

function getAllyTreatyStatus(
  treaties: Treaties,
  fetching: boolean,
  alliance?: string[],
  status?: ConnectionStatus
): Status | 'awaiting' | 'partial' | 'finished' {
  const treatyCount = Object.keys(treaties).length;
  if (alliance && alliance.length !== 0 && treatyCount === alliance.length) {
    return 'finished';
  }

  if (treatyCount > 0) {
    return 'partial';
  }

  if (!status || ('complete' in status && status.complete === 'no-data')) {
    return 'initial';
  }

  if (fetching || 'pending' in status) {
    return 'loading';
  }

  if ('complete' in status && status.complete === 'yes') {
    return alliance && alliance.length > 0 ? 'awaiting' : 'finished';
  }

  return 'error';
}

export function useAllyTreaties(ship: string) {
  const { data, showConnection } = useConnectivityCheck(ship);
  const allies = useAllies();
  const isAllied = ship in allies;
  const [fetching, setFetching] = useState(false);
  const treaties = useDocketState(
    useCallback(
      (s) => {
        const charter = s.allies[ship];
        return pick(s.treaties, ...(charter || []));
      },
      [ship]
    )
  );
  const status = getAllyTreatyStatus(
    treaties,
    fetching,
    allies[ship],
    data?.status
  );

  useEffect(() => {
    if (Object.keys(allies).length > 0 && !isAllied) {
      useDocketState.getState().addAlly(ship);
    }
  }, [allies, isAllied, ship]);

  useEffect(() => {
    async function fetchTreaties() {
      try {
        setFetching(true);
        await useDocketState.getState().fetchAllyTreaties(ship);
        setFetching(false);
      } catch {
        console.log("couldn't fetch initial treaties");
      }
    }

    if (isAllied) {
      fetchTreaties();
    }
  }, [ship, isAllied]);

  return {
    isAllied,
    treaties,
    status,
    connection: data,
    showConnection,
    awaiting: allies[ship]?.length || 0 - Object.keys(treaties).length,
  };
}

export function useTreaty(host: string, desk: string) {
  return useDocketState(
    useCallback(
      (s) => {
        const ref = `${host}/${desk}`;
        return s.treaties[ref];
      },
      [host, desk]
    )
  );
}

export function allyForTreaty(ship: string, desk: string) {
  const ref = `${ship}/${desk}`;
  const { allies } = useDocketState.getState();
  const ally = Object.entries(allies).find(([, allied]) =>
    allied.includes(ref)
  )?.[0];
  return ally;
}

export const landscapeTreatyHost = import.meta.env.LANDSCAPE_HOST as string;

// xx useful for debugging
window.docket = useDocketState.getState;

export default useDocketState;
