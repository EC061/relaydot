"use client";

import { useEffect, useState } from "react";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "usage", label: "Usage" },
  { id: "storage", label: "Storage" },
  { id: "catalog", label: "Prices" },
  { id: "devices", label: "Devices" },
  { id: "activity", label: "Activity" }
];

/**
 * Highlights whichever section is currently in view. The previous markup
 * hard-coded `active` on Overview, so the navigation never responded to a
 * click even though the anchors resolved.
 */
export function SectionNav() {
  const [active, setActive] = useState(SECTIONS[0].id);

  useEffect(() => {
    const targets = SECTIONS.map((section) =>
      document.getElementById(section.id)
    ).filter((element): element is HTMLElement => element !== null);
    if (targets.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActive(visible[0].target.id);
        }
      },
      // Offset the sticky top bar so a section counts as current only once it
      // clears the header.
      { rootMargin: "-88px 0px -55% 0px", threshold: 0 }
    );
    for (const target of targets) {
      observer.observe(target);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label="Primary navigation">
      {SECTIONS.map((section, index) => (
        <a
          aria-current={active === section.id ? "true" : undefined}
          className={active === section.id ? "active" : undefined}
          href={`#${section.id}`}
          key={section.id}
        >
          <span>{String(index + 1).padStart(2, "0")}</span> {section.label}
        </a>
      ))}
    </nav>
  );
}
