import { ApiError } from '../api';

export function ErrorBox({ error }: { error: ApiError }) {
  const message = error.status === 404 ? 'This link does not match anything in your household.' : error.message;
  return (
    <div className="banner error" role="alert">
      {message}
    </div>
  );
}
