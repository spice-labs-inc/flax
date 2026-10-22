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
    org: {
        github: string;
    };
    planes: Array<{
        id: string;
        label: string;
        slug: string;
        color: string;
    }>;
    views: ViewerView[];
    defaultPlanes: string[];
}
