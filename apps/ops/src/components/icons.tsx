import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: React.ReactNode) {
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
        {paths}
      </svg>
    );
  };
}

export const IconOverview = make(
  <>
    <rect x="2" y="2" width="5" height="6" rx="1" />
    <rect x="9" y="2" width="5" height="3.5" rx="1" />
    <rect x="9" y="7.5" width="5" height="6.5" rx="1" />
    <rect x="2" y="10" width="5" height="4" rx="1" />
  </>,
);
export const IconTransactions = make(
  <>
    <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8" />
    <path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />
  </>,
);
export const IconCustomers = make(
  <>
    <circle cx="8" cy="5.5" r="2.75" />
    <path d="M2.75 13.5c.6-2.5 2.7-4 5.25-4s4.65 1.5 5.25 4" />
  </>,
);
export const IconCases = make(
  <>
    <path d="M2.5 9.5 4 3.5h8l1.5 6v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3Z" />
    <path d="M2.5 9.5h3l.75 1.5h3.5l.75-1.5h3" />
  </>,
);
export const IconLedger = make(
  <>
    <path d="M3 2.5h8.5a1 1 0 0 1 1 1v10H4a1 1 0 0 1-1-1v-10Z" />
    <path d="M3 11.5a1 1 0 0 1 1-1h8.5M6 5.5h4M6 7.75h4" />
  </>,
);
export const IconTreasury = make(
  <>
    <path d="M2 6 8 2.75 14 6" />
    <path d="M3 6.5v5M6.33 6.5v5M9.67 6.5v5M13 6.5v5M2 13.5h12" />
  </>,
);
export const IconReports = make(
  <>
    <path d="M4 1.75h5.25L12.5 5v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z" />
    <path d="M9 1.75V5.25h3.5M5.75 12V9.5M8 12V7.75M10.25 12v-1.5" />
  </>,
);
export const IconProviders = make(
  <>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M2.25 8h11.5M8 2.25c1.6 1.7 2.4 3.6 2.4 5.75S9.6 12.05 8 13.75M8 2.25C6.4 3.95 5.6 5.85 5.6 8s.8 4.05 2.4 5.75" />
  </>,
);
export const IconJobs = make(
  <>
    <rect x="4" y="4" width="8" height="8" rx="1.25" />
    <rect x="6.5" y="6.5" width="3" height="3" rx=".5" />
    <path d="M6 1.75V4M10 1.75V4M6 12v2.25M10 12v2.25M1.75 6H4M1.75 10H4M12 6h2.25M12 10h2.25" />
  </>,
);
export const IconStaff = make(
  <>
    <path d="M8 1.75 13 3.5v4c0 3-2.1 5.4-5 6.75C5.1 12.9 3 10.5 3 7.5v-4l5-1.75Z" />
    <path d="m5.75 8 1.5 1.5 3-3" />
  </>,
);
export const IconAudit = make(
  <>
    <path d="M5.5 3.5h8M5.5 8h8M5.5 12.5h8" />
    <path d="M2.25 3.5h.5M2.25 8h.5M2.25 12.5h.5" />
  </>,
);
export const IconSettings = make(
  <>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </>,
);
export const IconSearch = make(
  <>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </>,
);
export const IconBell = make(
  <>
    <path d="M4 10.5V7a4 4 0 1 1 8 0v3.5l1.25 1.75H2.75L4 10.5Z" />
    <path d="M6.5 13.75a1.6 1.6 0 0 0 3 0" />
  </>,
);
export const IconChevronRight = make(<path d="m6 3.5 4.5 4.5L6 12.5" />);
export const IconChevronLeft = make(<path d="M10 3.5 5.5 8l4.5 4.5" />);
export const IconChevronDown = make(<path d="m3.5 6 4.5 4.5L12.5 6" />);
export const IconChevronUp = make(<path d="M3.5 10 8 5.5l4.5 4.5" />);
export const IconSidebar = make(
  <>
    <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
    <path d="M6 2.75v10.5" />
  </>,
);
export const IconRefresh = make(
  <>
    <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
    <path d="M13.25 2.5v3h-3" />
  </>,
);
export const IconCopy = make(
  <>
    <rect x="5.25" y="5.25" width="8" height="8" rx="1.25" />
    <path d="M10.75 5.25V3.75a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.5" />
  </>,
);
export const IconExternal = make(
  <>
    <path d="M9 2.75h4.25V7M13.25 2.75 7.5 8.5" />
    <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  </>,
);
export const IconClose = make(<path d="m4 4 8 8M12 4l-8 8" />);
export const IconCheck = make(<path d="m3.25 8.5 3 3 6.5-7" />);
export const IconColumns = make(
  <>
    <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
    <path d="M6 2.75v10.5M10 2.75v10.5" />
  </>,
);
export const IconMenu = make(<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />);
export const IconArrowRight = make(<path d="M3 8h10M9 4l4 4-4 4" />);
export const IconDownload = make(
  <>
    <path d="M8 2.5v7.75M4.75 7 8 10.25 11.25 7" />
    <path d="M2.75 11.5v1.25a.75.75 0 0 0 .75.75h9a.75.75 0 0 0 .75-.75V11.5" />
  </>,
);
export const IconLock = make(
  <>
    <rect x="3.25" y="7" width="9.5" height="6.75" rx="1.25" />
    <path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" />
  </>,
);
export const IconEye = make(
  <>
    <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
    <circle cx="8" cy="8" r="2" />
  </>,
);
export const IconFilter = make(<path d="M2.5 3.5h11l-4.25 5v4l-2.5 1v-5L2.5 3.5Z" />);
export const IconSort = make(<path d="M5 3v10M2.75 5.25 5 3l2.25 2.25M11 13V3M8.75 10.75 11 13l2.25-2.25" />);
export const IconPause = make(<path d="M5.5 3.5v9M10.5 3.5v9" />);
export const IconPlay = make(<path d="M4.5 3 12.5 8l-8 5V3Z" />);
export const IconPlus = make(<path d="M8 3v10M3 8h10" />);
export const IconLogout = make(
  <>
    <path d="M6 2.75H3.75a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H6" />
    <path d="M10 5l3 3-3 3M13 8H6" />
  </>,
);
