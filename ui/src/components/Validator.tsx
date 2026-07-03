import Form, { type IChangeEvent } from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import type { ArticleBodySchema, ArticleValidationResult } from "../types/workspace";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

type ValidatorProps = {
  articleSchema?: ArticleBodySchema;
  articleJson: string;
  articleFormData: unknown;
  validation: ArticleValidationResult | null;
  onArticleJsonChange: (json: string) => void;
  onArticleFormDataChange: (formData: unknown) => void;
  onValidateArticleBody: (articleBody: unknown) => void;
  onJsonParseError: () => void;
};

export function Validator({ articleSchema, articleJson, articleFormData, validation, onArticleJsonChange, onArticleFormDataChange, onValidateArticleBody, onJsonParseError }: ValidatorProps) {
  const validateJson = () => {
    try {
      onValidateArticleBody(JSON.parse(articleJson));
    } catch {
      onJsonParseError();
    }
  };

  return <section className="panel validator-panel"><h2>Article body validator</h2><div className="split"><div><h3>JSON input</h3><textarea rows={12} value={articleJson} onChange={(event) => onArticleJsonChange(event.target.value)} /><button onClick={validateJson}>Validate JSON</button></div><div><h3>RJSF input</h3>{articleSchema ? <Form schema={articleSchema} validator={validator} formData={articleFormData} onChange={(event: IChangeEvent) => onArticleFormDataChange(event.formData)} onSubmit={(event: IChangeEvent) => onValidateArticleBody(event.formData)} /> : <p>Load schema first.</p>}</div></div>{validation && <div><h3>Validation result</h3><pre>{pretty(validation)}</pre></div>}</section>;
}
