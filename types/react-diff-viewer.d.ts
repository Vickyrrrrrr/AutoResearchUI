declare module "react-diff-viewer-continued" {
  import type { ComponentType, CSSProperties } from "react";

  type DiffStyles = {
    variables?: Record<string, Record<string, string>>;
    contentText?: CSSProperties;
    line?: CSSProperties;
    marker?: CSSProperties;
  };

  export interface DiffViewerProps {
    oldValue: string;
    newValue: string;
    splitView?: boolean;
    hideLineNumbers?: boolean;
    showDiffOnly?: boolean;
    styles?: DiffStyles;
  }

  const DiffViewer: ComponentType<DiffViewerProps>;
  export default DiffViewer;
}
