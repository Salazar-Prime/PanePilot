import { PanelsTopLeft } from 'lucide-react';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="brand-title">
          <span className="brand-icon">
            <PanelsTopLeft aria-hidden="true" />
          </span>
          <span>
            PanePilot
            <small>System documentation</small>
          </span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
