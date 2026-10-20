// The slice of the atlas config the built page carries, embedded by `flax atlas build`
// as a JSON script tag beside the graph. Kept free of Node imports: the viewer reads it too.

export interface ViewerView {
  id: string;
  label: string;
  hint: string;
  layers: string[];
  planes: string[];
  byAdvisories?: boolean;
  mutedEdges?: boolean;
  subject?: string;
}

export interface ViewerConfig {
  site: {
    title: string;
    cname: string;
    searchPlaceholder: string;
    timezone: string;
  };
  org: { github: string };
  planes: Array<{ id: string; label: string; slug: string; color: string }>;
  views: ViewerView[];
  defaultPlanes: string[];
}
