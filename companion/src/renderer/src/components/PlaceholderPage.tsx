import { type FC } from "react";
import { Construction } from "lucide-react";

interface Props {
  title: string;
  roadmapStep: string;
  description?: string;
}

const PlaceholderPage: FC<Props> = ({ title, roadmapStep, description }) => {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="ui-card flex max-w-lg flex-col items-center gap-3 p-10 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Construction className="h-5 w-5" />
        </div>
        <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          {title}
        </h2>
        <p className="text-xs font-medium uppercase tracking-wider text-accent">
          {roadmapStep}
        </p>
        {description && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        )}
      </div>
    </div>
  );
};

export default PlaceholderPage;
